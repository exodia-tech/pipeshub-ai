from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.addons.knowledge_graph.service import GraphOverviewError, graph_page, page_adjacency


def item(key, parent=None):
    return SimpleNamespace(id=key, name=key, nodeType="record", parent=parent)


@pytest.mark.asyncio
async def test_only_visible_records_contribute_edges_and_names():
    provider = SimpleNamespace(
        get_record_taxonomy_links=AsyncMock(return_value=[
            {"recordId": "allowed", "entityId": "topic", "collection": "topics", "name": "Pricing"},
            {"recordId": "private", "entityId": "secret", "collection": "topics", "name": "Secret"},
        ]),
        get_named_entity_mentions_from_records=AsyncMock(return_value=[
            {"recordId": "allowed", "entityId": "person"},
            {"recordId": "private", "entityId": "private-person"},
        ]),
        get_named_entities_by_ids=AsyncMock(return_value=[{"_key": "person", "name": "Ada"}]),
    )
    result = await page_adjacency(provider, "org", [item("allowed", SimpleNamespace(id="hidden", name=None, nodeType="folder"))], named_enabled=True)
    assert {n["name"] for n in result["nodes"]} == {"allowed", "Pricing", "Ada"}
    assert len(result["edges"]) == 2
    provider.get_named_entities_by_ids.assert_awaited_once_with("org", ["person"])
    provider.get_record_taxonomy_links.assert_awaited_once_with(["allowed"], include_departments=True)


@pytest.mark.asyncio
async def test_disabled_entities_are_not_read_and_readable_parent_is_connected():
    provider = SimpleNamespace(get_record_taxonomy_links=AsyncMock(return_value=[]))
    result = await page_adjacency(provider, "org", [item("doc", SimpleNamespace(id="folder", name="Folder", nodeType="folder"))], named_enabled=False)
    assert result["edges"] == [{"source": "record:doc", "target": "record:folder"}]


@pytest.mark.asyncio
async def test_failed_adjacency_read_does_not_look_like_empty_graph():
    provider = SimpleNamespace(get_record_taxonomy_links=AsyncMock(side_effect=RuntimeError("unavailable")))
    with pytest.raises(RuntimeError):
        await page_adjacency(provider, "org", [item("doc")], named_enabled=False)


@pytest.mark.asyncio
async def test_page_uses_existing_listing_with_identity_and_signed_cursor():
    listing = SimpleNamespace(success=True, items=[], pagination=SimpleNamespace(hasNext=False, nextCursor=None, totalItems=0))
    service = SimpleNamespace(get_nodes=AsyncMock(return_value=listing))
    result = await graph_page(None, service, user_id="member", org_id="org", cursor="signed", named_enabled=False, source_limited=False)
    assert result == {"nodes": [], "edges": [], "listed": 0, "total": 0, "nextCursor": None}
    service.get_nodes.assert_awaited_once_with(user_id="member", org_id="org", flattened=True, limit=200, sort_by="name", sort_order="asc", cursor="signed")


@pytest.mark.asyncio
@pytest.mark.parametrize("success,error_code,code", [(False, 400, 400), (False, 500, 503), (True, 400, 503)])
async def test_refused_and_unpageable_listings_cannot_look_complete(success, error_code, code):
    listing = SimpleNamespace(success=success, errorCode=error_code, items=[], pagination=SimpleNamespace(hasNext=True, nextCursor=None))
    service = SimpleNamespace(get_nodes=AsyncMock(return_value=listing))
    with pytest.raises(GraphOverviewError) as exc:
        await graph_page(None, service, user_id="member", org_id="org", cursor=None, named_enabled=False, source_limited=False)
    assert exc.value.status_code == code


@pytest.mark.asyncio
async def test_source_limited_connection_is_refused_before_any_graph_read():
    service = SimpleNamespace(get_nodes=AsyncMock())
    with pytest.raises(GraphOverviewError) as exc:
        await graph_page(None, service, user_id="member", org_id="org", cursor=None, named_enabled=False, source_limited=True)
    assert exc.value.status_code == 403
    service.get_nodes.assert_not_awaited()
