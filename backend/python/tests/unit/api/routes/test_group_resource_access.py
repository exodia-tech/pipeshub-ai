"""Resource policy management through the authenticated service API."""

import json
import logging
from collections.abc import Iterator
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.api.middlewares.auth import authMiddleware
from app.api.routes.entity import router
from app.exceptions.graph_db_exceptions import PermissionVerificationUnavailableError
from app.services.graph_db.interface.graph_db_provider import IGraphDBProvider

GROUP = "8dbe044a-f322-44bd-9111-ae1d75eb6597"


def test_admin_can_restrict_a_group_to_one_channel_without_cross_tenant_grants() -> None:
    docs = {
        ("teams", GROUP): {"_key": GROUP, "orgId": "org-1", "exodiaAccessGroup": True},
        ("recordGroups", "finance"): {"_key": "finance", "orgId": "org-1", "groupName": "Finance"},
        ("recordGroups", "foreign"): {"_key": "foreign", "orgId": "org-2"},
    }
    graph = AsyncMock()
    graph.get_document.side_effect = lambda key, collection, *args, **kw: docs.get((collection, key))

    async def update(key, collection, values, *args, **kw) -> bool:
        docs[collection, key].update(values)
        return True

    graph.update_node.side_effect = update
    async def compare_update(org, group, policy, revision) -> bool:
        doc = docs["teams", group]
        if doc.get("exodiaResourceRevision", 0) != revision:
            return False
        doc.update(exodiaResourcePolicy=policy, exodiaResourceRevision=revision + 1)
        return True
    graph.update_group_resource_policy.side_effect = compare_update
    app = FastAPI()
    app.state.graph_provider = graph
    app.container = MagicMock()
    config = AsyncMock()
    config.get_config.return_value = {"jwtSecret": "local-only-regular-secret-32-chars-minimum", "scopedJwtSecret": "local-only-service-secret-32-chars-minimum"}
    app.container.config_service.return_value = config
    app.include_router(router, dependencies=[Depends(authMiddleware)])
    token = jwt.encode({"orgId": "org-1", "userId": "admin", "scopes": ["access-group:manage"]}, "local-only-service-secret-32-chars-minimum", algorithm="HS256")
    headers = {"Authorization": f"Bearer {token}"}
    path = f"/api/v1/entity/access-groups/{GROUP}/access"
    with patch("app.api.middlewares.auth.resolve_request_role", new=AsyncMock(return_value="admin")), TestClient(app) as client:
        assert client.put(path, headers=headers, json={"defaultAllow": False, "rules": [{"ref": "recordGroups/finance", "allow": True}]}).status_code == 200
        saved = client.get(path, headers=headers)
        assert saved.status_code == 200
        assert saved.json()["policy"] == {"defaultAllow": False, "revision": 1, "rules": [{"ref": "recordGroups/finance", "allow": True}], "featureScopes": None}
        assert client.put(path, headers=headers, json={"defaultAllow": True, "revision": 0, "rules": []}).status_code == 409
        assert client.put(path, headers=headers, json={"defaultAllow": True, "rules": [{"ref": "recordGroups/foreign", "allow": True}]}).status_code == 404
    assert json.loads(docs["teams", GROUP]["exodiaResourcePolicy"])["defaultAllow"] is False


def test_authenticated_content_and_search_reads_follow_folder_rules() -> None:
    policy = {"defaultAllow": False, "rules": [{"ref": "recordGroups/finance", "allow": True}, {"ref": "records/payroll", "allow": False}]}
    docs = {
        ("teams", GROUP): {"orgId": "org-1", "exodiaAccessGroup": True, "exodiaResourcePolicy": json.dumps(policy)},
        ("records", "report"): {"orgId": "org-1", "connectorId": "slack"},
        ("records", "payroll"): {"orgId": "org-1", "connectorId": "slack"},
        ("records", "other"): {"orgId": "org-1", "connectorId": "slack"},
        ("recordGroups", "finance"): {"orgId": "org-1", "connectorId": "slack"},
        ("apps", "slack"): {"orgId": "org-1"},
    }
    rows = [{"id": key, "vrid": key, "indexingStatus": "COMPLETED", "connectorId": "slack"} for key in ("report", "payroll", "other")]

    async def outgoing(ref, collection, *args, **kwargs) -> list[dict]:
        if collection == "permission" and ref == "users/member":
            return [{"_to": f"teams/{GROUP}"}]
        if collection == "belongsTo" and ref in ("records/report", "records/payroll"):
            return [{"_to": "recordGroups/finance"}]
        return []

    graph = SimpleNamespace(
        logger=logging.getLogger(__name__),
        _kh_v3_accessible_rows=AsyncMock(return_value=rows),
        get_document=AsyncMock(side_effect=lambda key, collection, *a, **k: docs.get((collection, key))),
        get_edges_from_node=AsyncMock(side_effect=outgoing),
        get_edges_to_node=AsyncMock(return_value=[]),
    )
    app = FastAPI()
    app.container = MagicMock()
    config = AsyncMock()
    config.get_config.return_value = {"jwtSecret": "local-only-regular-secret-32-chars-minimum", "scopedJwtSecret": "local-only-service-secret-32-chars-minimum"}
    app.container.config_service.return_value = config

    @app.get("/content", dependencies=[Depends(authMiddleware)])
    async def content() -> dict:
        decision = await IGraphDBProvider.check_access(graph, "member", "org-1", node_ids=["report", "payroll", "other", "private"], virtual_record_ids=["report", "payroll", "other", "private"])
        return {"readable": sorted(decision.node_ids), "search": sorted(decision.records_by_vrid)}

    token = jwt.encode({"orgId": "org-1", "userId": "member"}, "local-only-regular-secret-32-chars-minimum", algorithm="HS256")
    with patch("app.api.middlewares.auth.resolve_request_role", new=AsyncMock(return_value="member")), TestClient(app) as client:
        answer = client.get("/content", headers={"Authorization": f"Bearer {token}"})
        assert answer.status_code == 200
        assert answer.json() == {"readable": ["report"], "search": ["report"]}


@pytest.fixture
def resource_reader() -> Iterator[SimpleNamespace]:
    """Real auth/access checks; only the external graph data is a test double."""
    state = SimpleNamespace(
        docs={("teams", GROUP): {"orgId": "org-1", "exodiaAccessGroup": True,
            "exodiaResourcePolicy": json.dumps({"defaultAllow": False, "rules": [{"ref": "recordGroups/finance", "allow": True}]})}},
        memberships=[GROUP], parents={"records/report": ["recordGroups/finance"], "records/payroll": ["recordGroups/finance"]},
    )
    for collection, keys in [("records", ["report", "payroll", "other", "private"]), ("recordGroups", ["finance", "archive"]), ("apps", ["slack"])]:
        for key in keys:
            state.docs[collection, key] = {"orgId": "org-1", **({"connectorId": "slack"} if collection != "apps" else {})}

    async def rows(user, org, *args, **kwargs) -> list[dict]:
        return [{"id": key, "vrid": key, "indexingStatus": "COMPLETED", "connectorId": "slack"} for key in ["report", "payroll", "other"]] if (user, org) == ("member", "org-1") else []

    async def outgoing(ref, collection, *args, **kwargs) -> list[dict]:
        return [{"_to": f"teams/{group}"} for group in state.memberships] if collection == "permission" and ref == "users/member" else []

    async def incoming(ref, collection, *args, **kwargs) -> list[dict]:
        return [{"_from": parent, "relationshipType": "PARENT_CHILD"} for parent in state.parents.get(ref, [])]

    state.graph = SimpleNamespace(logger=logging.getLogger(__name__), _kh_v3_accessible_rows=rows,
        get_document=AsyncMock(side_effect=lambda key, collection, *a, **k: state.docs.get((collection, key))),
        get_edges_from_node=AsyncMock(side_effect=outgoing), get_edges_to_node=AsyncMock(side_effect=incoming))
    app = FastAPI()
    app.container = MagicMock()
    config = AsyncMock()
    config.get_config.return_value = {"jwtSecret": "local-only-regular-secret-32-chars-minimum", "scopedJwtSecret": "local-only-service-secret-32-chars-minimum"}
    app.container.config_service.return_value = config

    @app.get("/content", dependencies=[Depends(authMiddleware)])
    async def content(request: Request) -> dict:
        user = request.state.user
        try:
            decision = await IGraphDBProvider.check_access(state.graph, user["userId"], user["orgId"],
                node_ids=["report", "payroll", "other", "private"], virtual_record_ids=["report", "payroll", "other", "private"])
        except PermissionVerificationUnavailableError:
            raise HTTPException(503, "Permissions could not be verified") from None
        return {"readable": sorted(decision.node_ids), "search": sorted(decision.records_by_vrid)}

    token = jwt.encode({"orgId": "org-1", "userId": "member"}, "local-only-regular-secret-32-chars-minimum", algorithm="HS256")
    state.headers = {"Authorization": f"Bearer {token}"}
    with patch("app.api.middlewares.auth.resolve_request_role", new=AsyncMock(return_value="member")), TestClient(app) as client:
        state.client = client
        yield state


def test_allow_everything_cannot_grant_private_source_records(resource_reader) -> None:
    state = resource_reader
    state.docs["teams", GROUP]["exodiaResourcePolicy"] = json.dumps({"defaultAllow": True, "rules": [{"ref": "records/private", "allow": True}]})
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 200
    assert response.json() == {"readable": ["other", "payroll", "report"], "search": ["other", "payroll", "report"]}


def test_specific_record_exception_overrides_a_folder_denial(resource_reader) -> None:
    state = resource_reader
    state.docs["teams", GROUP]["exodiaResourcePolicy"] = json.dumps({"defaultAllow": True, "rules": [{"ref": "recordGroups/finance", "allow": False}, {"ref": "records/report", "allow": True}]})
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 200
    assert response.json() == {"readable": ["other", "report"], "search": ["other", "report"]}


@pytest.mark.parametrize("explicit_record", [False, True])
def test_equal_depth_folder_conflict_denies_unless_the_record_has_an_exception(resource_reader, explicit_record) -> None:
    state = resource_reader
    state.parents["records/report"].append("recordGroups/archive")
    rules = [{"ref": "recordGroups/finance", "allow": True}, {"ref": "recordGroups/archive", "allow": False}]
    if explicit_record:
        rules.append({"ref": "records/report", "allow": True})
    state.docs["teams", GROUP]["exodiaResourcePolicy"] = json.dumps({"defaultAllow": False, "rules": rules})
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 200
    expected = ["payroll", "report"] if explicit_record else ["payroll"]
    assert response.json() == {"readable": expected, "search": expected}


def test_joining_a_broad_group_cannot_override_another_groups_restriction(resource_reader) -> None:
    state = resource_reader
    state.docs["teams", "restricted"] = {"orgId": "org-1", "exodiaAccessGroup": True, "exodiaResourcePolicy": json.dumps({"defaultAllow": True, "rules": [{"ref": "records/report", "allow": False}]})}
    state.docs["teams", "broad"] = {"orgId": "org-1", "exodiaAccessGroup": True, "exodiaResourcePolicy": json.dumps({"defaultAllow": True, "rules": [{"ref": "records/report", "allow": True}]})}
    state.memberships.extend(["restricted", "broad"])
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 200
    assert response.json() == {"readable": ["payroll"], "search": ["payroll"]}


def test_policy_changes_are_rechecked_on_the_next_authenticated_read(resource_reader) -> None:
    state = resource_reader
    assert state.client.get("/content", headers=state.headers).json()["readable"] == ["payroll", "report"]
    state.docs["teams", GROUP]["exodiaResourcePolicy"] = json.dumps({"defaultAllow": False, "rules": []})
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 200
    assert response.json() == {"readable": [], "search": []}


@pytest.mark.parametrize("policy", ["broken-json", '{"defaultAllow":"false"}', '{"rules":[{"ref":"records/report","allow":true},{"ref":"records/report","allow":false}]}', '{"rules":[{"ref":"secrets/private","allow":true}]}'])
def test_malformed_stored_policy_fails_closed_instead_of_returning_content(resource_reader, policy) -> None:
    state = resource_reader
    state.docs["teams", GROUP]["exodiaResourcePolicy"] = policy
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 503
    assert response.json() == {"detail": "Permissions could not be verified"}


@pytest.mark.parametrize("unavailable", ["foreign", "deleted", "missing"])
def test_unverifiable_resource_ancestry_fails_closed(resource_reader, unavailable) -> None:
    state = resource_reader
    if unavailable == "foreign":
        state.docs["recordGroups", "finance"]["orgId"] = "org-2"
    elif unavailable == "deleted":
        state.docs["recordGroups", "finance"]["isDeleted"] = True
    else:
        del state.docs["recordGroups", "finance"]
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 503
    assert response.json() == {"detail": "Permissions could not be verified"}


def test_a_hierarchy_cycle_terminates_without_expanding_access(resource_reader) -> None:
    state = resource_reader
    state.parents["recordGroups/finance"] = ["recordGroups/archive"]
    state.parents["recordGroups/archive"] = ["recordGroups/finance"]
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 200
    assert response.json() == {"readable": ["payroll", "report"], "search": ["payroll", "report"]}


def test_an_oversized_hierarchy_fails_closed_without_returning_partial_content(resource_reader) -> None:
    state = resource_reader
    state.parents["records/report"] = ["recordGroups/deep-0"]
    for depth in range(52):
        state.docs["recordGroups", f"deep-{depth}"] = {"orgId": "org-1", "connectorId": "slack"}
        if depth < 51:
            state.parents[f"recordGroups/deep-{depth}"] = [f"recordGroups/deep-{depth+1}"]
    response = state.client.get("/content", headers=state.headers)
    assert response.status_code == 503
    assert response.json() == {"detail": "Permissions could not be verified"}
