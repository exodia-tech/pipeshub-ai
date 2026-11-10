"""Graph adjacency from one page of the same listing used by All Records."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.services.graph_db.taxonomy import TAXONOMY_ENTITY_TYPE_BY_COLLECTION

if TYPE_CHECKING:
    from app.connectors.sources.localKB.api.knowledge_hub_models import NodeItem
    from app.connectors.sources.localKB.handlers.knowledge_hub_service import KnowledgeHubService
    from app.services.graph_db.interface.graph_db_provider import IGraphDBProvider


class GraphOverviewError(Exception):
    def __init__(self, status_code: int = 503) -> None:
        super().__init__("Graph lookup failed - try again.")
        self.status_code = status_code


async def graph_page(
    provider: IGraphDBProvider, listing_service: KnowledgeHubService, *,
    user_id: str, org_id: str, cursor: str | None, named_enabled: bool, source_limited: bool,
) -> dict[str, Any]:
    # A full overview must never widen a connected app's narrower source grant.
    if source_limited:
        raise GraphOverviewError(403)
    # Keep each source fanout within the listing's shared transaction-memory budget.
    listing = await listing_service.get_nodes(
        user_id=user_id, org_id=org_id, flattened=True, limit=200,
        sort_by="name", sort_order="asc", cursor=cursor,
    )
    if not listing.success:
        raise GraphOverviewError(400 if listing.errorCode == 400 else 503)
    if listing.pagination.hasNext and not listing.pagination.nextCursor:
        raise GraphOverviewError()
    adjacency = await page_adjacency(provider, org_id, listing.items, named_enabled=named_enabled)
    return {
        **adjacency, "listed": len(listing.items), "total": listing.pagination.totalItems,
        "nextCursor": listing.pagination.nextCursor,
    }


async def page_adjacency(provider: IGraphDBProvider, org_id: str, items: list[NodeItem], *, named_enabled: bool) -> dict[str, Any]:
    nodes: dict[str, dict] = {}
    edges: set[tuple[str, str]] = set()
    record_ids = {item.id for item in items if item.nodeType in ("record", "folder")}
    for item in items:
        key = f"record:{item.id}"
        nodes[key] = {"id": key, "name": item.name, "kind": item.nodeType, "recordId": item.id}
        # A nameless parent is deliberately redacted by the listing's access check.
        if item.parent and item.parent.name is not None:
            parent = f"record:{item.parent.id}"
            nodes.setdefault(parent, {"id": parent, "name": item.parent.name, "kind": item.parent.nodeType, "recordId": item.parent.id})
            edges.add((key, parent))

    def attach(record_id: str, entity_id: str, kind: str, name: str) -> None:
        if record_id not in record_ids or not entity_id:
            return
        key = f"entity:{kind}:{entity_id}"
        nodes[key] = {"id": key, "name": name, "kind": kind}
        edges.add((f"record:{record_id}", key))

    if record_ids:
        for row in await provider.get_record_taxonomy_links(sorted(record_ids), include_departments=True):
            kind = TAXONOMY_ENTITY_TYPE_BY_COLLECTION.get(row.get("collection", ""))
            if kind:
                attach(row["recordId"], row["entityId"], kind, row.get("name") or "")
        if named_enabled:
            mentions = await provider.get_named_entity_mentions_from_records(org_id, sorted(record_ids))
            ids = sorted({r["entityId"] for r in mentions if r.get("recordId") in record_ids})
            entities = await provider.get_named_entities_by_ids(org_id, ids) if ids else []
            by_id = {str(e.get("id") or e.get("_key")): e for e in entities}
            for row in mentions:
                entity = by_id.get(row.get("entityId"))
                if entity:
                    attach(row["recordId"], row["entityId"], "named_entity", entity.get("name") or "")
    return {"nodes": list(nodes.values()), "edges": [{"source": a, "target": b} for a, b in sorted(edges) if a != b]}
