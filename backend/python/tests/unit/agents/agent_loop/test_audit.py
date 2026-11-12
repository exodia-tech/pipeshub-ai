"""Audit consumes upstream events, without copying model or tool content."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import jwt
import pytest
from aiohttp import web

from app.agent_loop_lib.core.context import RunContext
from app.agent_loop_lib.events.base import AgentEvent, EventType
from app.agents.agent_loop.audit import AuditEventEmitter
from app.agents.agent_loop.context import AgentContext

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

SECRET = "local-only-audit-service-secret-with-enough-length"
ORG = "0123456789abcdef01234567"
USER = "123456789abcdef012345678"


@pytest.fixture
async def audit_server() -> AsyncIterator:
    received = []

    async def ingest(request) -> web.Response:
        claims = jwt.decode(
            request.headers["Authorization"][7:], SECRET, algorithms=["HS256"]
        )
        received.append((claims, await request.json()))
        await asyncio.sleep(config.delay)
        return web.json_response({"recorded": True}, status=config.status)

    app = web.Application()
    app.router.add_post("/api/v1/audit/internal/events", ingest)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    class Config:
        status = 201
        delay = 0

        async def get_config(self, key, **kwargs) -> dict:
            if key == "/services/secretKeys":
                return {"scopedJwtSecret": SECRET}
            return {"iam": {"endpoint": f"http://127.0.0.1:{port}"}}

    config = Config()
    try:
        yield received, config
    finally:
        await runner.cleanup()


async def test_tool_outcome_uses_request_identity_and_drops_sensitive_payload(
    audit_server,
) -> None:
    received, config = audit_server
    emitter = AuditEventEmitter(
        AgentContext(
            org_id=ORG,
            user_id=USER,
            user_email="private@example.invalid",
            config_service=config,
        )
    )
    event = AgentEvent(
        event_type=EventType.TOOL_RESULT,
        run_context=RunContext(
            role_name="worker",
            model="fixture-model",
            run_id="run-1",
            trace_id="trace-1",
            agent_id="agent-1",
        ),
        payload={
            "tool": "fetch_record",
            "tool_call_id": "call-1",
            "status": "success",
            "args": {"token": "secret-input"},
            "content": "private-output",
            "org_id": "forged-org",
        },
    )
    await emitter.emit(event)
    assert len(received) == 1
    claims, body = received[0]
    assert (claims["orgId"], claims["userId"], claims["scopes"]) == (
        ORG,
        USER,
        ["audit:write"],
    )
    assert claims["exp"] - claims["iat"] == 60
    assert body == {
        "event_id": event.event_id,
        "action": "agent.tool",
        "outcome": "success",
        "agent_event": {
            "run_id": "run-1",
            "trace_id": "trace-1",
            "agent_id": "agent-1",
            "tool_call_id": "call-1",
            "tool_name": "fetch_record",
            "model": "fixture-model",
        },
    }


@pytest.mark.parametrize(
    ("kind", "status", "expected"),
    [
        (EventType.AGENT_START, None, "intent"),
        (EventType.TOOL_CALL, None, "intent"),
        (EventType.TOOL_RESULT, "error", "failed"),
        (EventType.TOOL_BLOCKED, "blocked", "denied"),
        (EventType.TOOL_BLOCKED, "awaiting_approval", "pending"),
    ],
)
async def test_preserves_upstream_outcomes_and_child_run_correlation(
    audit_server, kind, status, expected
) -> None:
    received, config = audit_server
    emitter = AuditEventEmitter(
        AgentContext(org_id=ORG, user_id=USER, user_email="", config_service=config)
    )
    await emitter.emit(
        AgentEvent(
            event_type=kind,
            run_context=RunContext(
                role_name="child", model="fixture-model", parent_run_id="parent-run"
            ),
            payload={
                "tool": "mcp_drive_read",
                "tool_call_id": "call-1",
                "status": status,
                "error": "private error",
            },
        )
    )
    assert len(received) == 1
    assert received[0][1]["outcome"] == expected
    assert received[0][1]["agent_event"]["parent_run_id"] == "parent-run"
    assert "private error" not in str(received)


async def test_aliases_tokens_and_progress_do_not_duplicate_audit_events(
    audit_server,
) -> None:
    received, config = audit_server
    emitter = AuditEventEmitter(
        AgentContext(org_id=ORG, user_id=USER, user_email="", config_service=config)
    )
    for kind in [
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
        EventType.RUN_ERROR,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_END,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.STATE_SNAPSHOT,
    ]:
        await emitter.emit(
            AgentEvent(
                event_type=kind,
                run_context=RunContext(role_name="worker", model="fixture"),
                payload={"delta": "private token"},
            )
        )
    assert received == []


@pytest.mark.parametrize("failure", ["unavailable", "timeout"])
async def test_audit_outage_is_reported_without_breaking_the_agent_event(
    audit_server, caplog, failure
) -> None:
    received, config = audit_server
    config.status = 503 if failure == "unavailable" else 201
    config.delay = 3 if failure == "timeout" else 0
    emitter = AuditEventEmitter(
        AgentContext(org_id=ORG, user_id=USER, user_email="", config_service=config)
    )
    event = AgentEvent(
        event_type=EventType.AGENT_START,
        run_context=RunContext(role_name="worker", model="fixture"),
        payload={"goal": "private goal"},
    )
    await asyncio.wait_for(emitter.emit(event), timeout=2.5)
    assert len(received) == 1
    assert "Agent audit event write was not confirmed" in caplog.text
    assert "private goal" not in caplog.text


@pytest.mark.parametrize(
    "outcome",
    ["success", "failed", "denied", "pending", "post_blocked", "audit_unavailable"],
)
async def test_real_agent_uses_hook_decisions_and_emits_one_tool_outcome(
    audit_server, outcome
) -> None:
    from app.agent_loop_lib.agent import Agent
    from app.agent_loop_lib.agent.spec import AgentSpec, ModelSpec
    from app.agent_loop_lib.core.messages import ToolCall
    from app.agent_loop_lib.core.types import Goal
    from app.agent_loop_lib.hooks.events import HookEvent
    from app.agent_loop_lib.hooks.middleware.decisions import PendingApproval
    from app.agent_loop_lib.runtime.runtime import AgentRuntime
    from app.agent_loop_lib.tools.base import Tool, ToolOutput
    from app.agent_loop_lib.tools.registry import ToolRegistry
    from app.agent_loop_lib.transport.registry import TransportRegistry
    from tests.unit.agents.adapter.support.scripted_transport import ScriptedTransport

    class FixtureTool(Tool):
        name = "fixture_read"
        short_description = description = "Local fixture read"
        path = "/toolsets/fixture/read"
        parameters = []
        executions = 0

        async def execute(self, **kwargs) -> ToolOutput:
            self.executions += 1
            return ToolOutput(
                success=outcome != "failed",
                data="private result",
                error="private failure" if outcome == "failed" else None,
            )

    received, config = audit_server
    if outcome == "audit_unavailable":
        config.status = 503
    registry, transports = ToolRegistry(), TransportRegistry()
    tool = FixtureTool()
    registry.register_tool(tool)
    transport = (
        ScriptedTransport()
        .add_tool_call(ToolCall(id="call-1", name=tool.name, arguments={}))
        .add_text("private answer")
    )
    transports.register("scripted", lambda: transport)
    audit = AuditEventEmitter(
        AgentContext(org_id=ORG, user_id=USER, user_email="", config_service=config)
    )
    runtime = AgentRuntime(
        transport_registry=transports, tool_registry=registry, event_emitter=audit
    )
    runtime.hooks.on(HookEvent.POST_AGENT).use(audit.run_outcome)

    async def gate(ctx, next_fn) -> None:
        if outcome == "denied":
            ctx.deny("private denial reason")
        elif outcome == "pending":
            ctx.ask_later(PendingApproval(message="private approval question"))
        else:
            await next_fn()

    runtime.hooks.on(HookEvent.PRE_TOOL_USE).use(gate)
    if outcome == "post_blocked":

        async def redact(ctx, next_fn) -> None:
            ctx.block("private result must not be released")

        runtime.hooks.on(HookEvent.POST_TOOL_USE).use(redact)
    agent = Agent(
        AgentSpec(
            name="fixture",
            system_prompt="Fixture",
            model=ModelSpec(provider="scripted", model="fixture-model"),
        ),
        runtime,
    )
    result = await agent.run(Goal(description="private goal"))
    assert result.success
    assert tool.executions == (0 if outcome in ("denied", "pending") else 1)
    expected_outcome = (
        "failed"
        if outcome == "post_blocked"
        else "success"
        if outcome == "audit_unavailable"
        else outcome
    )
    events = [body for _, body in received]
    assert [(e["action"], e["outcome"]) for e in events] == [
        ("agent.run", "intent"),
        ("agent.tool", "intent"),
        ("agent.tool", expected_outcome),
        ("agent.run", "success"),
    ]
    assert "private" not in str(events)


async def test_concurrent_agent_events_keep_each_requests_verified_identity(
    audit_server,
) -> None:
    received, config = audit_server
    other_org, other_user = "abcdef0123456789abcdef01", "bcdef0123456789abcdef012"
    left = AuditEventEmitter(
        AgentContext(org_id=ORG, user_id=USER, user_email="", config_service=config)
    )
    right = AuditEventEmitter(
        AgentContext(
            org_id=other_org, user_id=other_user, user_email="", config_service=config
        )
    )
    await asyncio.gather(
        *[
            emitter.emit(
                AgentEvent(
                    event_type=EventType.AGENT_START,
                    run_context=RunContext(
                        role_name="fixture", model="fixture", run_id=run
                    ),
                )
            )
            for emitter, run in [(left, "left-run"), (right, "right-run")]
        ]
    )
    actual = {
        body["agent_event"]["run_id"]: (claims["orgId"], claims["userId"])
        for claims, body in received
    }
    assert actual == {"left-run": (ORG, USER), "right-run": (other_org, other_user)}


@pytest.mark.parametrize("protocol", ["legacy", "agui", "background"])
async def test_platform_factory_audits_runs_and_preserves_the_stream(
    audit_server, monkeypatch, protocol
) -> None:
    from app.agents.agent_loop.factory import PipesHubAgentFactory
    from tests.unit.agents.adapter.conftest import FakeChatModel, make_context

    received, config = audit_server
    frames = []

    class Sink:
        async def write(self, event) -> bool:
            frames.append(event)
            return True

    monkeypatch.setenv("PIPESHUB_ENABLE_SKILLS", "false")
    monkeypatch.delenv("SANDBOX_MODE", raising=False)
    context = make_context(
        org_id=ORG,
        user_id=USER,
        config_service=config,
        llm=FakeChatModel(),
        event_sink=None if protocol == "background" else Sink(),
        protocol="legacy" if protocol == "background" else protocol,
    )
    agent, _, goal, _ = await PipesHubAgentFactory().create(
        context, context.llm, "quick", query="private goal", model_name="fixture-model"
    )
    result = await agent.run(goal)
    assert result.success
    assert [(body["action"], body["outcome"]) for _, body in received] == [
        ("agent.run", "intent"),
        ("agent.run", "success"),
    ]
    assert all(
        claims["orgId"] == ORG and claims["userId"] == USER for claims, _ in received
    )
    assert bool(frames) == (protocol != "background")
    assert "private goal" not in str(received)


@pytest.mark.parametrize("state", ["denied_before_start", "model_failed", "cancelled"])
async def test_run_outcome_covers_refusal_failure_and_cancellation(
    audit_server, state
) -> None:
    from app.agent_loop_lib.agent import Agent
    from app.agent_loop_lib.agent.spec import AgentSpec, ModelSpec
    from app.agent_loop_lib.core.context import CancellationToken
    from app.agent_loop_lib.core.types import Goal
    from app.agent_loop_lib.hooks.events import HookEvent
    from app.agent_loop_lib.runtime.runtime import AgentRuntime
    from app.agent_loop_lib.tools.registry import ToolRegistry
    from app.agent_loop_lib.transport.registry import TransportRegistry
    from tests.unit.agents.adapter.support.scripted_transport import ScriptedTransport

    received, config = audit_server
    audit = AuditEventEmitter(
        AgentContext(org_id=ORG, user_id=USER, user_email="", config_service=config)
    )
    transports = TransportRegistry()
    transport = ScriptedTransport().add_error(RuntimeError("private model error"))
    transports.register("scripted", lambda: transport)
    cancellation = CancellationToken()
    if state == "cancelled":
        cancellation.cancel()
    runtime = AgentRuntime(
        transport_registry=transports,
        tool_registry=ToolRegistry(),
        event_emitter=audit,
        cancellation_token=cancellation,
    )
    runtime.hooks.on(HookEvent.POST_AGENT).use(audit.run_outcome)
    if state == "denied_before_start":

        async def deny(ctx, next_fn) -> None:
            ctx.deny("private policy reason")

        runtime.hooks.on(HookEvent.PRE_AGENT).use(deny)
    result = await Agent(
        AgentSpec(model=ModelSpec(provider="scripted", model="fixture")), runtime
    ).run(Goal(description="private goal"))
    assert not result.success
    assert [body["outcome"] for _, body in received] == [
        "intent",
        "cancelled" if state == "cancelled" else "failed",
    ]
    assert "private" not in str(received)
