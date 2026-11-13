"""Native user-facing scope dependencies apply live group limits, including sessions."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from app.api.middlewares.auth import authMiddleware, require_scopes
from app.config.constants.service import TokenScopes

SECRET = "synthetic-feature-scope-test-secret-32-characters"


def request_action(scopes: list[str] | None, *, token_scopes: list[str] | None = None,
                   storage_failure: bool = False, admin: bool = False,
                   other_scopes: list[str] | None = None, corrupt: bool = False,
                   agent_id: str | None = None, service: bool = False,
                   virtual_service_account: bool = False,
                   steering_named: bool | None = None) -> int:
    app = FastAPI()
    graph = AsyncMock()
    graph.get_graph_user_keys_by_mongo_user_ids.return_value = {"member": "graph-member"}
    groups = {"group": {"_key": "group", "orgId": "org", "exodiaAccessGroup": True,
                         "exodiaResourcePolicy": json.dumps({"featureScopes": scopes})}}
    edges = [{"_to": "teams/group"}]
    if other_scopes is not None:
        groups["other"] = {"_key": "other", "orgId": "org", "exodiaAccessGroup": True,
                           "exodiaResourcePolicy": json.dumps({"featureScopes": other_scopes})}
        edges.append({"_to": "teams/other"})
    if corrupt:
        groups["group"]["exodiaResourcePolicy"] = "malformed"
    graph.get_document.side_effect = lambda key, *_args, **_kwargs: (
        {"_key": "graph-member", "orgId": "org", "isActive": True} if key == "graph-member" else groups.get(key)
    )
    graph.get_edges_from_node.return_value = edges
    if storage_failure:
        graph.get_edges_from_node.side_effect = RuntimeError("synthetic storage outage")
    app.state.graph_provider = graph
    app.container = MagicMock()
    config = AsyncMock()
    config.get_config.return_value = {"jwtSecret": SECRET, "scopedJwtSecret": SECRET + "-service"}
    app.container.config_service.return_value = config

    required = ("agent:execute", "conversation:chat") if agent_id else ("agent:execute",)
    @app.get("/execute", dependencies=[Depends(authMiddleware), Depends(require_scopes(*required, service_scopes=(TokenScopes.CONVERSATION_CREATE,)))])
    async def execute(request: Request) -> dict:
        if agent_id:
            from app.api.routes.agent import require_agent_execute_for_named_agents
            await require_agent_execute_for_named_agents(request, agent_id)
        return {"allowed": True}

    if steering_named is not None:
        from app.agents.agent_loop.cancellation.registry import RunOwner
        from app.agents.agent_loop.steering import SteeringInbox
        from app.api.routes.steering import router, steering_inbox_dependency
        from tests.unit.agents.agent_loop.test_steering import Store

        inbox = SteeringInbox(Store())
        run = "11111111-1111-4111-8111-111111111111"
        asyncio.run(inbox.register(run, RunOwner(user_id="member", org_id="org", conversation_id="chat")))
        state = asyncio.run(inbox.read(run))
        state["namedAgent"] = steering_named
        asyncio.run(inbox.write(run, state))
        app.include_router(router, dependencies=[Depends(authMiddleware)])
        app.dependency_overrides[steering_inbox_dependency] = lambda: inbox

    claims = {"orgId": "org", "userId": "member", "featureScopes": ["agent:execute"]}
    if virtual_service_account:
        claims["isServiceAccount"] = True
        graph.get_graph_user_keys_by_mongo_user_ids.return_value = {}
    if token_scopes is not None:
        claims.update({"tokenType": "oauth", "scope": " ".join(token_scopes)})
    if service:
        claims["scopes"] = ["conversation:create"]
    token = jwt.encode(claims, SECRET + "-service" if service else SECRET, algorithm="HS256")
    with patch("app.api.middlewares.auth.resolve_request_role", new=AsyncMock(return_value="admin" if admin else "member")), TestClient(app) as client:
        if steering_named is not None:
            response = client.post("/chat/steer", headers={"Authorization": f"Bearer {token}"}, json={
                "runId": run, "conversationId": "chat", "messageId": "message", "text": "New instructions",
                "namedAgent": False,
            })
            if response.status_code == 403:
                assert asyncio.run(inbox.read(run))["messages"] == []
            return response.status_code
        return client.get("/execute", headers={"Authorization": f"Bearer {token}"}).status_code


@pytest.mark.parametrize("scopes,expected", [(None, 200), ([], 403), (["agent:read"], 403), (["agent:execute"], 200)])
def test_sessions_use_live_group_limits(scopes: list[str] | None, expected: int) -> None:
    assert request_action(scopes) == expected


@pytest.mark.parametrize("group,token,expected", [(["agent:execute"], ["agent:read"], 403),
    (["agent:read"], ["agent:execute"], 403), (["agent:execute"], ["agent:execute"], 200)])
def test_oauth_needs_both_token_and_group_scope(group: list[str], token: list[str], expected: int) -> None:
    assert request_action(group, token_scopes=token) == expected


def test_other_group_cannot_override_a_scope_denial() -> None:
    assert request_action(["agent:execute"], other_scopes=["agent:read"]) == 403


def test_storage_failure_and_malformed_policy_fail_closed() -> None:
    assert request_action(None, storage_failure=True) == 503
    assert request_action(None, corrupt=True) == 503


def test_admin_recovery_still_respects_oauth_grant() -> None:
    assert request_action([], storage_failure=True, admin=True) == 200
    assert request_action([], admin=True, token_scopes=["agent:read"]) == 403


@pytest.mark.parametrize("service,token", [(False, None), (False, ["agent:execute", "conversation:chat"]), (True, None)])
def test_named_agents_cannot_use_the_generic_chat_scope(service: bool, token: list[str] | None) -> None:
    assert request_action(["conversation:chat"], token_scopes=token, agent_id="named-agent", service=service) == 403


def test_actor_service_tokens_cannot_bypass_group_limits() -> None:
    assert request_action([], service=True) == 403


def test_native_virtual_service_account_keeps_configured_bot_access() -> None:
    assert request_action(None, service=True, virtual_service_account=True) == 200


def test_regular_token_cannot_claim_virtual_service_account_privileges() -> None:
    assert request_action([], virtual_service_account=True) == 503


async def test_org_only_indexing_tokens_keep_the_native_service_policy() -> None:
    request = SimpleNamespace(state=SimpleNamespace(user={
        "token_type": "scoped", "orgId": "org", "scopes": ["connector:signedUrl"],
    }))
    await require_scopes("connector:read", service_scopes=(TokenScopes.CONNECTOR_SIGNED_URL,))(request)


def test_universal_chat_keeps_its_native_chat_scope() -> None:
    assert request_action(["conversation:chat"], agent_id="agentIdPlaceholder") == 200


def test_named_steering_cannot_use_chat_permission_or_a_forged_run_kind() -> None:
    assert request_action(["conversation:chat"], steering_named=True) == 403


@pytest.mark.parametrize("scope", ["conversation:chat", "agent:execute"])
def test_universal_steering_keeps_both_native_scope_alternatives(scope: str) -> None:
    assert request_action([scope], token_scopes=[scope], steering_named=False) == 200
