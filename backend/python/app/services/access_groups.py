"""Graph-backed access groups: membership has one source of truth."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from app.config.constants.arangodb import CollectionNames
from app.services.cache.invalidation_hooks import notify_principals_changed
from app.utils.time_conversion import get_epoch_timestamp_in_ms

if TYPE_CHECKING:
    from app.services.graph_db.interface.graph_db_provider import IGraphDBProvider


class AccessGroups:
    def __init__(self, graph: IGraphDBProvider) -> None:
        self.graph = graph

    async def list(self, org_id: str, skip: int, limit: int) -> list[dict]:
        if not org_id or skip < 0 or not 1 <= limit <= 100:
            raise ValueError("Invalid group listing parameters")
        groups = await self.graph.get_documents_paginated(
            CollectionNames.TEAMS.value,
            skip=skip,
            limit=limit,
            filters={"orgId": org_id, "exodiaAccessGroup": True},
            sort_field="_key",
            raise_on_error=True,
        )
        creator_keys = list({group["createdBy"] for group in groups if group.get("createdBy")})
        creators = await self.graph.get_nodes_by_field_in(
            CollectionNames.USERS.value, "_key", creator_keys,
            return_fields=["_key", "orgId", "userId", "fullName", "email"],
            raise_on_error=True,
        ) if creator_keys else []
        by_key = {user["_key"]: user for user in creators if user.get("orgId") == org_id}
        for group in groups:
            creator = by_key.get(group.get("createdBy"))
            group["createdByUser"] = {
                "userId": creator.get("userId"),
                "name": creator.get("fullName"),
                "email": creator.get("email"),
            } if creator else None
        return groups

    async def create(self, org_id: str, creator_id: str, name: str, description: str = "") -> str:
        name = name.strip()
        if not name or len(name) > 120 or len(description) > 2000 or not org_id or not creator_id:
            raise ValueError("Organization, creator and group name are required")
        # shortcut: concurrent creates can use the same name until graph stores have an org/name constraint.
        if await self.graph.find_team_by_name(org_id, name):
            raise ValueError("A team or group with this name already exists")
        creator = await self.graph.get_graph_user_keys_by_mongo_user_ids(
            [creator_id], org_id=org_id, chunk_size=500
        )
        if creator_id not in creator:
            raise ValueError("Creator not found")
        group_id = str(uuid.uuid4())
        now = get_epoch_timestamp_in_ms()
        saved = await self.graph.batch_upsert_nodes(
            [
                {
                    "_key": group_id,
                    "name": name,
                    "description": description.strip(),
                    "orgId": org_id,
                    "createdBy": creator[creator_id],
                    "createdAtTimestamp": now,
                    "updatedAtTimestamp": now,
                    "exodiaAccessGroup": True,
                }
            ],
            CollectionNames.TEAMS.value,
        )
        if not saved:
            raise RuntimeError("Could not create access group")
        return group_id

    async def _require_group(self, org_id: str, group_id: str) -> None:
        group = await self.graph.get_document(group_id, CollectionNames.TEAMS.value)
        if (
            not group
            or group.get("orgId") != org_id
            or group.get("exodiaAccessGroup") is not True
        ):
            raise ValueError("Access group not found")

    async def delete(self, org_id: str, group_id: str) -> None:
        await self._require_group(org_id, group_id)
        try:
            await self.graph.delete_nodes_and_edges(
                [group_id], CollectionNames.TEAMS.value
            )
        finally:
            await notify_principals_changed(org_id)

    async def rename(self, org_id: str, group_id: str, name: str, description: str | None = None) -> None:
        await self._require_group(org_id, group_id)
        name = name.strip()
        if not name or len(name) > 120 or (description is not None and len(description) > 2000):
            raise ValueError("Invalid group name")
        if await self.graph.find_team_by_name(org_id, name, exclude_team_id=group_id):
            raise ValueError("A team or group with this name already exists")
        if not await self.graph.update_node(
            group_id,
            CollectionNames.TEAMS.value,
            {"name": name, "updatedAtTimestamp": get_epoch_timestamp_in_ms(),
             **({"description": description.strip()} if description is not None else {})},
        ):
            raise RuntimeError("Could not rename access group")

    async def members(
        self, org_id: str, group_id: str, actor_id: str, page: int, limit: int
    ) -> dict:
        await self._require_group(org_id, group_id)
        if page < 1 or not 1 <= limit <= 100:
            raise ValueError("Invalid member page")
        actor = await self.graph.get_graph_user_keys_by_mongo_user_ids(
            [actor_id], org_id=org_id, chunk_size=500
        )
        result = await self.graph.get_team_users(
            group_id,
            org_id,
            actor[actor_id],
            page=page,
            limit=limit,
            include_service_accounts=True,
        )
        if result is None:
            raise RuntimeError("Could not list group members")
        return result

    async def _members(
        self,
        org_id: str,
        group_id: str,
        user_ids: list[str],
        *,
        require_active: bool = False,
    ) -> list[str]:
        await self._require_group(org_id, group_id)
        if not user_ids:
            raise ValueError("At least one member is required")
        unique = list(dict.fromkeys(user_ids))
        mapping = await self.graph.get_graph_user_keys_by_mongo_user_ids(
            unique, org_id=org_id, chunk_size=500
        )
        if len(mapping) != len(unique):
            raise ValueError("One or more members were not found")
        if require_active:
            for member in mapping.values():
                user = await self.graph.get_document(
                    member, CollectionNames.USERS.value
                )
                if (
                    not user
                    or user.get("orgId") != org_id
                    or user.get("isActive") is not True
                ):
                    raise ValueError("One or more members are not active")
        return [mapping[user_id] for user_id in unique]

    async def add_members(
        self, org_id: str, group_id: str, user_ids: list[str]
    ) -> None:
        members = await self._members(org_id, group_id, user_ids, require_active=True)
        now = get_epoch_timestamp_in_ms()
        edges = [
            {
                "from_id": member,
                "from_collection": CollectionNames.USERS.value,
                "to_id": group_id,
                "to_collection": CollectionNames.TEAMS.value,
                "type": "USER",
                "role": "READER",
                "createdAtTimestamp": now,
                "updatedAtTimestamp": now,
            }
            for member in members
        ]
        try:
            if not await self.graph.batch_create_edges(
                edges, CollectionNames.PERMISSION.value
            ):
                raise RuntimeError("Could not add access group members")
        finally:
            await notify_principals_changed(org_id)

    async def remove_members(
        self, org_id: str, group_id: str, user_ids: list[str]
    ) -> None:
        members = await self._members(org_id, group_id, user_ids)
        try:
            await self.graph.delete_team_member_edges(group_id, members)
        finally:
            await notify_principals_changed(org_id)
