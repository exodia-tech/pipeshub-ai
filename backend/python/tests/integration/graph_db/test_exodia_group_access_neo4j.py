"""Exercise the existing graph access path on the disposable EXODIA test store."""

import logging
import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.graph_db.neo4j.neo4j_provider import Neo4jProvider


@pytest.mark.asyncio
async def test_team_membership_grant_and_revocation_changes_collection_access(
    monkeypatch,
) -> None:
    if os.environ.get("EXODIA_TEST_NEO4J") != "bolt://127.0.0.1:52413":
        pytest.skip("Requires the isolated EXODIA graph test container")
    monkeypatch.setenv("NEO4J_URI", "bolt://127.0.0.1:52413")
    monkeypatch.setenv("NEO4J_USERNAME", "neo4j")
    monkeypatch.setenv("NEO4J_PASSWORD", "localtestpass")
    provider = Neo4jProvider(logging.getLogger(__name__), MagicMock())
    assert await provider.connect()
    suffix = uuid.uuid4().hex
    ids = {
        name: f"exodia-test-{name}-{suffix}"
        for name in ("org", "user", "other", "team", "kb")
    }
    try:
        await provider.client.execute_query(
            """
            CREATE (u:User {id:$user, userId:$user, orgId:$org})
            CREATE (:User {id:$other, userId:$other, orgId:$org})
            CREATE (t:Teams {id:$team, orgId:$org})
            CREATE (k:App {id:$kb, orgId:$org, type:'KB', name:'Example'})
            CREATE (u)-[:PERMISSION {type:'USER', role:'READER'}]->(t)
            CREATE (t)-[:PERMISSION {type:'TEAM', role:'READER'}]->(k)
            """,
            parameters=ids,
        )
        member, _, _ = await provider.list_user_knowledge_bases(
            ids["user"], ids["org"], 0, 20
        )
        outsider, _, _ = await provider.list_user_knowledge_bases(
            ids["other"], ids["org"], 0, 20
        )
        assert [row["id"] for row in member] == [ids["kb"]]
        assert outsider == []
        assert await provider.delete_team_member_edges(ids["team"], [ids["user"]])
        revoked, _, _ = await provider.list_user_knowledge_bases(
            ids["user"], ids["org"], 0, 20
        )
        assert revoked == []
    finally:
        await provider.client.execute_query(
            "MATCH (n) WHERE n.id IN $ids DETACH DELETE n",
            parameters={"ids": list(ids.values())},
        )
        await provider.disconnect()


@pytest.mark.asyncio
async def test_membership_revocation_reports_graph_unavailability(monkeypatch) -> None:
    if os.environ.get("EXODIA_TEST_NEO4J") != "bolt://127.0.0.1:52413":
        pytest.skip("Requires the isolated EXODIA graph test container")
    monkeypatch.setenv("NEO4J_URI", "bolt://127.0.0.1:52413")
    monkeypatch.setenv("NEO4J_USERNAME", "neo4j")
    monkeypatch.setenv("NEO4J_PASSWORD", "localtestpass")
    provider = Neo4jProvider(logging.getLogger(__name__), MagicMock())
    assert await provider.connect()
    await provider.disconnect()
    with pytest.raises((AttributeError, RuntimeError)):
        await provider.delete_team_member_edges(
            "unavailable-team", ["unavailable-user"]
        )
    with pytest.raises((AttributeError, RuntimeError)):
        await provider.batch_update_team_member_roles(
            "unavailable-team", [{"userId": "unavailable-user", "role": "READER"}], 0
        )


@pytest.mark.asyncio
async def test_unconnected_provider_rejects_revocation_and_role_changes() -> None:
    provider = Neo4jProvider(logging.getLogger(__name__), MagicMock())
    with pytest.raises((AttributeError, RuntimeError)):
        await provider.delete_team_member_edges(
            "unavailable-team", ["unavailable-user"]
        )
    with pytest.raises((AttributeError, RuntimeError)):
        await provider.batch_update_team_member_roles(
            "unavailable-team", [{"userId": "unavailable-user", "role": "READER"}], 0
        )


@pytest.mark.asyncio
async def test_postgres_revocation_propagates_storage_failure() -> None:
    from app.core.org_context import OrgContext, bind
    from app.services.graph_db.postgres.identity import IdentityMixin

    provider = MagicMock()
    provider._id_rows = AsyncMock(side_effect=RuntimeError("graph unavailable"))
    with bind(OrgContext("test-org", "test-user", "user", "jwt", "test")):
        with pytest.raises(RuntimeError, match="graph unavailable"):
            await IdentityMixin.delete_team_member_edges(
                provider, "test-team", ["test-user"]
            )


@pytest.mark.asyncio
async def test_access_group_is_graph_authoritative_and_rejects_foreign_members(
    monkeypatch,
) -> None:
    if os.environ.get("EXODIA_TEST_NEO4J") != "bolt://127.0.0.1:52413":
        pytest.skip("Requires the isolated EXODIA graph test container")
    from app.services.access_groups import AccessGroups

    monkeypatch.setenv("NEO4J_URI", "bolt://127.0.0.1:52413")
    monkeypatch.setenv("NEO4J_USERNAME", "neo4j")
    monkeypatch.setenv("NEO4J_PASSWORD", "localtestpass")
    graph = Neo4jProvider(logging.getLogger(__name__), MagicMock())
    assert await graph.connect()
    suffix = uuid.uuid4().hex
    ids = {
        name: f"exodia-test-{name}-{suffix}"
        for name in ("org", "admin", "member", "inactive", "foreign", "kb")
    }
    group_id = None
    try:
        await graph.client.execute_query(
            """CREATE (:User {id:$admin, userId:$admin, orgId:$org, isActive:true})
            CREATE (:User {id:$member, userId:$member, orgId:$org, isActive:true})
            CREATE (:User {id:$inactive, userId:$inactive, orgId:$org, isActive:false})
            CREATE (:User {id:$foreign, userId:$foreign, orgId:'foreign'})
            CREATE (:App {id:$kb, orgId:$org, type:'KB', name:'Example'})""",
            parameters=ids,
        )
        groups = AccessGroups(graph)
        with pytest.raises(ValueError):
            await groups.create(ids["org"], ids["foreign"], "Invalid group")
        group_id = await groups.create(ids["org"], ids["admin"], "Example group")
        with pytest.raises(ValueError):
            await groups.create(ids["org"], ids["admin"], "Example group")
        own_groups = await groups.list(ids["org"], 0, 100)
        other_groups = await groups.list("another-org", 0, 100)
        assert any(group.get("_key") == group_id for group in own_groups)
        await groups.rename(ids["org"], group_id, "Renamed group")
        assert any(
            group.get("name") == "Renamed group"
            for group in await groups.list(ids["org"], 0, 100)
        )
        assert all(group.get("_key") != group_id for group in other_groups)
        share_targets, _ = await graph.get_user_teams(
            ids["admin"], org_id=ids["org"], is_org_admin=True
        )
        assert any(team.get("id") == group_id for team in share_targets)
        with pytest.raises(ValueError):
            await groups.add_members("another-org", group_id, [ids["member"]])
        shared = await graph.create_kb_permissions(ids["kb"], ids["admin"], [], [group_id], "READER")
        assert shared["success"] is True
        before, _, _ = await graph.list_user_knowledge_bases(
            ids["admin"], ids["org"], 0, 20
        )
        assert before == []
        with pytest.raises(ValueError):
            await groups.add_members(
                ids["org"], group_id, [ids["member"], ids["foreign"]]
            )
        with pytest.raises(ValueError):
            await groups.add_members(ids["org"], group_id, [ids["inactive"]])
        denied, _, _ = await graph.list_user_knowledge_bases(
            ids["member"], ids["org"], 0, 20
        )
        assert denied == []
        await groups.add_members(ids["org"], group_id, [ids["member"]])
        members = await groups.members(ids["org"], group_id, ids["admin"], 1, 100)
        assert [person["userId"] for person in members["members"]] == [ids["member"]]
        allowed, _, _ = await graph.list_user_knowledge_bases(
            ids["member"], ids["org"], 0, 20
        )
        assert [item["id"] for item in allowed] == [ids["kb"]]
        assert allowed[0]["userRole"] == "READER"
        await groups.remove_members(ids["org"], group_id, [ids["member"]])
        revoked, _, _ = await graph.list_user_knowledge_bases(
            ids["member"], ids["org"], 0, 20
        )
        assert revoked == []
        await groups.add_members(ids["org"], group_id, [ids["member"]])
        await groups.delete(ids["org"], group_id)
        deleted_access, _, _ = await graph.list_user_knowledge_bases(
            ids["member"], ids["org"], 0, 20
        )
        assert deleted_access == []
        assert not any(
            group.get("_key") == group_id
            for group in await groups.list(ids["org"], 0, 100)
        )
    finally:
        await graph.client.execute_query(
            "MATCH (n) WHERE n.id IN $ids DETACH DELETE n",
            parameters={"ids": [*ids.values(), group_id]},
        )
        await graph.disconnect()
