from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import APIRouter, FastAPI, Request

from app.addons import register_search_addons
from app.addons.knowledge_graph import router as addon


@pytest.mark.asyncio
async def test_addon_uses_host_identity_and_semantic_scope_policy(monkeypatch):
    app = FastAPI()
    user = {"isOAuth": True, "oauthScopes": ["semantic:read"]}

    @app.middleware("http")
    async def identity_state(request, call_next):
        request.state.user = user
        return await call_next(request)

    config = object()
    provider = object()
    app.container = SimpleNamespace(config_service=lambda: config)
    graph_page = AsyncMock(return_value={"nodes": [], "edges": [], "listed": 0, "total": 0, "nextCursor": None})
    monkeypatch.setattr(addon, "graph_page", graph_page)
    monkeypatch.setattr(addon, "is_named_entity_extraction_enabled", AsyncMock(return_value=False))
    async def get_provider(request: Request):
        return provider

    router = APIRouter()
    register_search_addons(router, identity=lambda request: ("host-org", "host-user"), provider=get_provider)
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        result = await client.post("/search/graph", json={"orgId": "other-org", "userId": "other-user"})
        assert result.status_code == 200, result.text
        assert graph_page.await_args.kwargs["org_id"] == "host-org"
        assert graph_page.await_args.kwargs["user_id"] == "host-user"
        assert graph_page.await_args.kwargs["source_limited"] is False
        graph_page.reset_mock()
        user["oauthScopes"] = []
        assert (await client.post("/search/graph", json={})).status_code == 403
        graph_page.assert_not_awaited()
        user["oauthScopes"] = ["semantic:read"]
        assert (await client.post("/search/graph", json={"cursor": ""})).status_code == 422
        graph_page.assert_not_awaited()
