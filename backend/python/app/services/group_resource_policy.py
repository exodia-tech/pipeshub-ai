"""Brain restrictions intersect source access; a local allow never creates a source grant."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from app.config.constants.arangodb import CollectionNames
from app.services.cache.invalidation_hooks import notify_principals_changed

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from app.services.graph_db.interface.graph_db_provider import IGraphDBProvider

RESOURCE_COLLECTIONS = {"apps", "recordGroups", "records"}


class ResourcePolicyConflict(Exception):
    pass


def split_ref(ref: str) -> tuple[str, str]:
    parts = ref.split("/")
    if (
        len(parts) != 2
        or parts[0] not in RESOURCE_COLLECTIONS
        or not re.fullmatch(r"[^/\x00-\x1f]{1,256}", parts[1])
    ):
        raise ValueError("Invalid resource reference")
    return parts[0], parts[1]


class ResourceRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ref: str
    allow: StrictBool

    @field_validator("ref")
    @classmethod
    def valid_ref(cls, value: str) -> str:
        split_ref(value)
        return value


class ResourcePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    defaultAllow: StrictBool = True
    revision: int = Field(default=0, ge=0, strict=True)
    rules: list[ResourceRule] = Field(default_factory=list, max_length=1000)

    @field_validator("rules")
    @classmethod
    def unique_refs(cls, rules: list[ResourceRule]) -> list[ResourceRule]:
        if len({rule.ref for rule in rules}) != len(rules):
            raise ValueError("Duplicate resource rule")
        return rules

    def allows(self, distances: dict[str, int]) -> bool:
        matches = [
            (distances[rule.ref], rule.allow)
            for rule in self.rules
            if rule.ref in distances
        ]
        if not matches:
            return self.defaultAllow
        nearest = min(distance for distance, _ in matches)
        return all(allow for distance, allow in matches if distance == nearest)


class GroupResourceAccess:
    def __init__(self, graph: IGraphDBProvider) -> None:
        self.graph = graph
        self._paths: dict[tuple[str, str], dict[str, int]] = {}

    async def group(self, org_id: str, group_id: str) -> dict:
        group = await self.graph.get_document(
            group_id, CollectionNames.TEAMS.value, raise_on_error=True
        )
        if (
            not group
            or group.get("orgId") != org_id
            or group.get("exodiaAccessGroup") is not True
        ):
            raise ValueError("Access group not found")
        return group

    async def read(self, org_id: str, group_id: str) -> ResourcePolicy:
        group = await self.group(org_id, group_id)
        policy = (
            ResourcePolicy.model_validate_json(group["exodiaResourcePolicy"])
            if group.get("exodiaResourcePolicy")
            else ResourcePolicy()
        )
        return policy.model_copy(
            update={"revision": group.get("exodiaResourceRevision", 0)}
        )

    async def save(self, org_id: str, group_id: str, policy: ResourcePolicy) -> None:
        await self.group(org_id, group_id)
        for rule in policy.rules:
            collection, key = split_ref(rule.ref)
            doc = await self.graph.get_document(key, collection, raise_on_error=True)
            if not doc or doc.get("orgId") != org_id or doc.get("isDeleted"):
                raise ValueError("Resource not found")
        # JSON also works on graph stores whose properties cannot hold nested maps.
        saved = await self.graph.update_group_resource_policy(
            org_id,
            group_id,
            policy.model_dump_json(exclude={"revision"}),
            policy.revision,
        )
        if not saved:
            raise ResourcePolicyConflict(
                "The group policy changed; reload before saving"
            )
        await notify_principals_changed(org_id)

    @staticmethod
    def edge_ref(edge: dict, side: str) -> str | None:
        value = edge.get(f"_{side}")
        if value:
            return value
        collection, key = edge.get(f"{side}_collection"), edge.get(f"{side}_id")
        return f"{collection}/{key}" if collection and key else None

    async def policies_for_user(
        self, org_id: str, user_key: str
    ) -> list[ResourcePolicy]:
        if not user_key:
            raise ValueError("User identity is required for resource restrictions")
        edges = await self.graph.get_edges_from_node(
            f"users/{user_key}", CollectionNames.PERMISSION.value, raise_on_error=True
        )
        policies = []
        for ref in {self.edge_ref(edge, "to") for edge in edges}:
            if not ref or not ref.startswith("teams/"):
                continue
            group = await self.graph.get_document(
                ref.split("/", 1)[1], "teams", raise_on_error=True
            )
            if (
                not group
                or group.get("orgId") != org_id
                or group.get("exodiaAccessGroup") is not True
            ):
                continue
            if group.get("exodiaResourcePolicy"):
                policy = ResourcePolicy.model_validate_json(
                    group["exodiaResourcePolicy"]
                )
                if not policy.defaultAllow or policy.rules:
                    policies.append(policy)
        return policies

    async def user_has_restrictions(self, org_id: str, user_id: str) -> bool:
        mapping = await self.graph.get_graph_user_keys_by_mongo_user_ids(
            [user_id], org_id=org_id, chunk_size=500
        )
        if not mapping.get(user_id):
            raise ValueError("Viewer identity is unavailable")
        return bool(await self.policies_for_user(org_id, mapping[user_id]))

    async def distances(self, org_id: str, ref: str) -> dict[str, int]:
        if (org_id, ref) in self._paths:
            return self._paths[org_id, ref]
        distances: dict[str, int] = {}
        pending = [(ref, 0)]
        while pending:
            current, depth = pending.pop(0)
            if current in distances:
                continue
            if depth > 50 or len(distances) >= 5000:
                raise RuntimeError("Resource hierarchy exceeds the access-check limit")
            collection, key = split_ref(current)
            doc = await self.graph.get_document(key, collection, raise_on_error=True)
            if not doc or doc.get("orgId") != org_id or doc.get("isDeleted"):
                raise ValueError("Resource hierarchy is unavailable")
            distances[current] = depth + (
                1000
                if collection == "apps"
                else 500
                if collection == "recordGroups"
                else 0
            )
            if collection == "apps":
                continue
            incoming = await self.graph.get_edges_to_node(
                current, CollectionNames.NODE_RELATIONS.value, raise_on_error=True
            )
            outgoing = await self.graph.get_edges_from_node(
                current, CollectionNames.BELONGS_TO.value, raise_on_error=True
            )
            parents = {
                self.edge_ref(edge, "from")
                for edge in incoming
                if edge.get("relationshipType") in {"PARENT_CHILD", "ATTACHMENT"}
            }
            parents.update(self.edge_ref(edge, "to") for edge in outgoing)
            # Source records can name their connector without a physical parent edge.
            if doc.get("connectorId"):
                parents.add(f"apps/{doc['connectorId']}")
            for parent in parents:
                if parent:
                    split_ref(parent)
                    pending.append((parent, depth + 1))
        self._paths[org_id, ref] = distances
        return distances

    async def resources(
        self,
        org_id: str,
        group_id: str,
        parent_ref: str | None,
        skip: int,
        limit: int,
        actor_id: str,
    ) -> dict:
        policy = await self.read(org_id, group_id)
        if parent_ref:
            collection, key = split_ref(parent_ref)
            parent = await self.graph.get_document(key, collection, raise_on_error=True)
            if not parent or parent.get("orgId") != org_id or parent.get("isDeleted"):
                raise ValueError("Resource not found")
            children = await self.graph.get_edges_from_node(
                parent_ref, CollectionNames.NODE_RELATIONS.value, raise_on_error=True
            )
            owned = await self.graph.get_edges_to_node(
                parent_ref, CollectionNames.BELONGS_TO.value, raise_on_error=True
            )
            direct = {
                self.edge_ref(edge, "to")
                for edge in children
                if edge.get("relationshipType") in {"PARENT_CHILD", "ATTACHMENT"}
            }
            refs = set(direct)
            refs.update(self.edge_ref(edge, "from") for edge in owned)
            refs = sorted(ref for ref in refs if ref)
            if len(refs) > 5000:
                raise RuntimeError("Open a smaller resource scope")
            docs = []
            for ref in refs:
                collection, key = split_ref(ref)
                doc = await self.graph.get_document(
                    key, collection, raise_on_error=True
                )
                if doc and doc.get("orgId") == org_id and not doc.get("isDeleted"):
                    if ref not in direct:
                        hierarchy = await self.graph.get_edges_to_node(
                            ref,
                            CollectionNames.NODE_RELATIONS.value,
                            raise_on_error=True,
                        )
                        if any(
                            edge.get("relationshipType")
                            in {"PARENT_CHILD", "ATTACHMENT"}
                            for edge in hierarchy
                        ):
                            continue
                    docs.append((ref, doc))
            page = docs[skip : skip + limit]
            has_more = len(docs) > skip + limit
        else:
            docs = await self.graph.get_documents_paginated(
                "apps",
                skip=skip,
                limit=limit + 1,
                filters={"orgId": org_id},
                sort_field="_key",
                raise_on_error=True,
            )
            page = [
                (f"apps/{doc.get('_key') or doc.get('id')}", doc)
                for doc in docs[:limit]
            ]
            has_more = len(docs) > limit
        nodes = []
        explicit = {rule.ref: rule.allow for rule in policy.rules}
        for ref, doc in page:
            path = await self.distances(org_id, ref)
            collection, _ = split_ref(ref)
            navigable = policy.allows(path)
            if not navigable:
                for rule in policy.rules:
                    if rule.allow and ref in await self.distances(org_id, rule.ref):
                        navigable = True
                        break
            nodes.append(
                {
                    "ref": ref,
                    "name": doc.get("recordName")
                    or doc.get("groupName")
                    or doc.get("name")
                    or ref,
                    "kind": "connector"
                    if collection == "apps"
                    else "container"
                    if collection == "recordGroups"
                    or doc.get("recordType") == "FOLDER"
                    or "folder" in (doc.get("mimeType") or "")
                    else "record",
                    "allowed": policy.allows(path),
                    "navigable": navigable,
                    "explicit": explicit.get(ref),
                    "connectorType": doc.get("connectorName") or doc.get("type"),
                    "descendantRuleRefs": [
                        rule.ref
                        for rule in policy.rules
                        if rule.ref != ref
                        and ref in await self.distances(org_id, rule.ref)
                    ],
                }
            )
        from app.services.access_groups import AccessGroups

        membership = await AccessGroups(self.graph).members(
            org_id, group_id, actor_id, 1, 100
        )
        members = membership.get("members") or []
        member_count = membership.get("memberCount", len(members))
        complete = member_count <= len(members)
        readable_counts = {node["ref"]: 0 for node in nodes}
        if complete:
            mapping = await self.graph.get_graph_user_keys_by_mongo_user_ids(
                [member["userId"] for member in members], org_id=org_id, chunk_size=500
            )
            for member in members:
                key = mapping.get(member["userId"])
                if not key:
                    complete = False
                    break
                decision = await self.graph.check_access(
                    key, org_id, node_ids=[split_ref(node["ref"])[1] for node in nodes]
                )
                for ref in readable_counts:
                    if split_ref(ref)[1] in decision.node_ids:
                        readable_counts[ref] += 1
        for node in nodes:
            node["readableMembers"] = readable_counts[node["ref"]] if complete else None
        return {
            "nodes": nodes,
            "hasMore": has_more,
            "policy": policy.model_dump(),
            "memberCount": member_count,
        }

    async def restrict_rows(
        self, org_id: str, user_key: str, rows: list[dict], *, navigation: bool = False
    ) -> list[dict]:
        policies = await self.policies_for_user(org_id, user_key)
        if not policies:
            return rows
        admitted = []
        # shortcut: bounded individual hierarchy reads; batch this port before enabling on large tenants.
        for row in rows:
            refs = []
            for collection in ("records", "recordGroups", "apps"):
                doc = await self.graph.get_document(
                    row["id"], collection, raise_on_error=True
                )
                if doc and doc.get("orgId") == org_id and not doc.get("isDeleted"):
                    refs.append(f"{collection}/{row['id']}")
            if len(refs) != 1:
                continue
            paths = await self.distances(org_id, refs[0])
            # Every configured group restriction applies; joining another group cannot bypass a restriction.
            decisions = []
            for policy in policies:
                allowed = policy.allows(paths)
                if not allowed and navigation:
                    for rule in policy.rules:
                        if rule.allow and refs[0] in await self.distances(
                            org_id, rule.ref
                        ):
                            allowed = True
                            break
                decisions.append(allowed)
            if all(decisions):
                admitted.append(row)
        return admitted

    async def filtered_page(
        self,
        org_id: str,
        user_key: str,
        fetch_page: Callable[[dict | None], Awaitable[dict]],
        *,
        after: dict | None,
        direction: str,
        limit: int,
    ) -> dict:
        """Filter before issuing a public cursor; denied names and counts never enter it."""
        from app.utils.kh_cursor import Boundary

        if not await self.policies_for_user(org_id, user_key):
            return await fetch_page(after)
        collected = []
        boundary = after
        for _ in range(100):
            page = await fetch_page(boundary)
            raw = page.get("rows") or []
            allowed = await self.restrict_rows(org_id, user_key, raw, navigation=True)
            collected = (
                allowed + collected if direction == "prev" else collected + allowed
            )
            more = bool(page.get("hasMore"))
            if len(collected) > limit or not more:
                return {
                    **page,
                    "rows": collected[-limit:]
                    if direction == "prev"
                    else collected[:limit],
                    "hasMore": more or len(collected) > limit,
                    "total": None,
                    "counts": None,
                    "ids": [],
                }
            if not raw:
                raise RuntimeError("Resource page did not advance")
            next_boundary = Boundary.of(
                raw[0] if direction == "prev" else raw[-1]
            ).as_after()
            if next_boundary == boundary:
                raise RuntimeError("Resource page did not advance")
            boundary = next_boundary
        raise RuntimeError("Open a smaller resource scope")
