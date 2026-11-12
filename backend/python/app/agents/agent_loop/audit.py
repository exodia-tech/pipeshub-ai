"""Persist selected upstream events in the administrator audit history."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import TYPE_CHECKING

import aiohttp

from app.agent_loop_lib.events.base import AgentEvent, EventEmitter, EventType
from app.config.constants.service import (
    DefaultEndpoints,
    TokenScopes,
    config_node_constants,
)
from app.utils.jwt import generate_jwt

if TYPE_CHECKING:
    from app.agent_loop_lib.hooks.middleware.context import AgentLifecycleContext
    from app.agent_loop_lib.hooks.middleware.pipeline import Next
    from app.agents.agent_loop.context import AgentContext

logger = logging.getLogger(__name__)
_RUN_OUTCOMES = {
    EventType.AGENT_START: "intent",
    EventType.AGENT_COMPLETE: "success",
    EventType.ERROR: "failed",
    EventType.CANCELLATION: "cancelled",
}
_TOOL_OUTCOMES = {
    "success": "success",
    "error": "failed",
    "blocked": "denied",
    "awaiting_approval": "pending",
}


class AuditEventEmitter(EventEmitter):
    def __init__(self, context: AgentContext) -> None:
        self.context = context

    async def emit(self, event: AgentEvent) -> None:
        # POST_AGENT also covers runs refused before their first turn, which emit no terminal event.
        if event.event_type in (
            EventType.AGENT_COMPLETE,
            EventType.ERROR,
            EventType.CANCELLATION,
        ):
            return
        await self._record(event)

    async def run_outcome(self, ctx: AgentLifecycleContext, next_fn: Next) -> None:
        await next_fn()
        if ctx.scope is not None and ctx.result is not None:
            kind = (
                EventType.AGENT_COMPLETE
                if ctx.result.success
                else EventType.CANCELLATION
                if ctx.result.cancelled
                else EventType.ERROR
            )
            await self._record(
                AgentEvent(event_type=kind, run_context=ctx.scope.identity)
            )

    async def _record(self, event: AgentEvent) -> None:
        # Consume canonical events only: the AG-UI aliases describe the same operations.
        if event.event_type not in _RUN_OUTCOMES and event.event_type not in (
            EventType.TOOL_CALL,
            EventType.TOOL_RESULT,
            EventType.TOOL_BLOCKED,
        ):
            return
        try:
            async with asyncio.timeout(2):
                run = event.run_context
                metadata = {
                    "run_id": run.run_id,
                    "trace_id": run.trace_id,
                    "agent_id": run.agent_id,
                    "model": run.model,
                }
                if run.parent_run_id:
                    metadata["parent_run_id"] = run.parent_run_id
                if event.event_type in _RUN_OUTCOMES:
                    action, outcome = "agent.run", _RUN_OUTCOMES[event.event_type]
                else:
                    action = "agent.tool"
                    outcome = (
                        "intent"
                        if event.event_type == EventType.TOOL_CALL
                        else _TOOL_OUTCOMES[event.payload["status"]]
                    )
                    metadata.update(
                        tool_name=event.payload["tool"],
                        tool_call_id=event.payload["tool_call_id"],
                    )
                config = self.context.config_service
                token = await generate_jwt(
                    config,
                    {
                        "orgId": self.context.org_id,
                        "userId": self.context.user_id,
                        "scopes": [TokenScopes.AUDIT_WRITE.value],
                    },
                    timedelta(seconds=60),
                )
                endpoints = (
                    await config.get_config(
                        config_node_constants.ENDPOINTS.value, use_cache=True
                    )
                    or {}
                )
                endpoint = (endpoints.get("nodejs") or endpoints.get("iam") or {}).get(
                    "endpoint", DefaultEndpoints.NODEJS_ENDPOINT.value
                )
                async with aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=2)
                ) as client:
                    async with client.post(
                        f"{endpoint.rstrip('/')}/api/v1/audit/internal/events",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "event_id": event.event_id,
                            "action": action,
                            "outcome": outcome,
                            "agent_event": metadata,
                        },
                        allow_redirects=False,
                    ) as response:
                        if response.status != 201:
                            raise RuntimeError("Audit service did not accept the event")
        except Exception as error:
            # Reporting must not turn an executed tool into a retryable execution failure.
            logger.error(
                "Agent audit event write was not confirmed",
                extra={
                    "event_id": event.event_id,
                    "failure_type": type(error).__name__,
                },
            )
