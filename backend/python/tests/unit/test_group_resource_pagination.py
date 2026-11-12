"""Hidden rows must not consume public pages or escape in cursor metadata."""

from unittest.mock import AsyncMock

import pytest

from app.services.group_resource_policy import GroupResourceAccess, ResourcePolicy


@pytest.mark.asyncio
@pytest.mark.parametrize("direction", ["next", "prev"])
async def test_sparse_access_fills_pages_without_hidden_metadata(
    direction: str,
) -> None:
    access = GroupResourceAccess(AsyncMock())
    access.policies_for_user = AsyncMock(
        return_value=[ResourcePolicy(defaultAllow=False)]
    )
    access.restrict_rows = AsyncMock(
        side_effect=lambda org, user, rows, **kw: [
            row for row in rows if row["id"].startswith("visible")
        ]
    )
    rows = [
        {"id": key, "sortKey": key, "nullRank": 0, "parentIsInternal": False}
        for key in ("hidden", "visible-a", "visible-b")
    ]
    fetch = AsyncMock(
        side_effect=[
            {
                "rows": [row],
                "hasMore": i < 2,
                "total": 999,
                "counts": {"private": 99},
                "ids": ["hidden"],
            }
            for i, row in enumerate(rows)
        ]
    )
    result = await access.filtered_page(
        "org", "member", fetch, after=None, direction=direction, limit=1
    )
    assert [row["id"] for row in result["rows"]] == ["visible-a"]
    assert result["hasMore"] is True
    assert result["total"] is None and result["counts"] is None and result["ids"] == []
    assert fetch.await_count == 3


@pytest.mark.asyncio
async def test_nonadvancing_provider_fails_instead_of_looping() -> None:
    access = GroupResourceAccess(AsyncMock())
    access.policies_for_user = AsyncMock(
        return_value=[ResourcePolicy(defaultAllow=False)]
    )
    access.restrict_rows = AsyncMock(return_value=[])
    row = {
        "id": "hidden",
        "sortKey": "private-name",
        "nullRank": 0,
        "parentIsInternal": False,
    }
    fetch = AsyncMock(return_value={"rows": [row], "hasMore": True})
    with pytest.raises(RuntimeError, match="did not advance"):
        await access.filtered_page(
            "org", "member", fetch, after=None, direction="next", limit=1
        )
    assert fetch.await_count == 2
