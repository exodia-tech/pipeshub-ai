"""The graph group routes accept only the dedicated service token."""

from unittest.mock import AsyncMock, MagicMock, patch

import jwt
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.middlewares.auth import authMiddleware
from app.api.routes.entity import router


def test_internal_group_routes_reject_user_and_wrong_scope() -> None:
    app = FastAPI()
    app.include_router(router, dependencies=[Depends(authMiddleware)])
    app.state.graph_provider = AsyncMock()
    app.state.graph_provider.get_documents_paginated.return_value = []
    app.container = MagicMock()
    config = AsyncMock()
    config.get_config.return_value = {"jwtSecret": "local-only-regular-secret-32-chars-minimum", "scopedJwtSecret": "local-only-service-secret-32-chars-minimum"}
    app.container.config_service.return_value = config
    claims = {"orgId": "org-1", "userId": "user-1"}
    user = jwt.encode(claims, "local-only-regular-secret-32-chars-minimum", algorithm="HS256")
    wrong = jwt.encode({**claims, "scopes": ["fetch:config"]}, "local-only-service-secret-32-chars-minimum", algorithm="HS256")
    service = jwt.encode({**claims, "scopes": ["access-group:manage"]}, "local-only-service-secret-32-chars-minimum", algorithm="HS256")

    with patch("app.api.middlewares.auth.resolve_request_role", new=AsyncMock(return_value="member")), TestClient(app) as client:
        path = "/api/v1/entity/access-groups"
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": f"Bearer {user}"}).status_code == 403
        assert client.get(path, headers={"Authorization": f"Bearer {wrong}"}).status_code == 403
        assert client.get(path, headers={"Authorization": f"Bearer {service}"}).status_code == 200
    assert app.state.graph_provider.get_documents_paginated.await_count == 1
    assert app.state.graph_provider.get_documents_paginated.await_args.kwargs[
        "filters"
    ] == {
        "orgId": "org-1",
        "exodiaAccessGroup": True,
    }
