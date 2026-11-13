"""Personal usage is private; organization analytics and pricing require a verified admin."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from app.api.middlewares.admin_gate import require_admin_caller
from app.api.middlewares.auth import deny_service_tokens, require_scopes
from app.config.constants.service import OAuthScopes
from app.services.usage.ledger import UsageLedger, timestamp
from app.services.usage.meter import enabled, health

router = APIRouter(prefix="/usage", dependencies=[Depends(deny_service_tokens)])


def caller(request: Request) -> tuple[str, str]:
    user = getattr(request.state, "user", None) or {}
    if not user.get("orgId") or not user.get("userId"):
        raise HTTPException(401, "An authenticated organization member is required")
    if not enabled():
        raise HTTPException(
            503, "Usage tracking is not configured on persistent storage"
        )
    return str(user["orgId"]), str(user["userId"])


async def visibility(request: Request, view: str) -> tuple[str, str | None]:
    org, user = caller(request)
    if view == "organization":
        await require_admin_caller(request)
        return org, None
    return org, user


class ObservabilitySetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


@router.get(
    "/observability",
    dependencies=[
        Depends(require_scopes(OAuthScopes.CONFIG_READ)),
        Depends(require_admin_caller),
    ],
)
async def get_observability(request: Request) -> dict:
    org, _ = caller(request)
    return {
        "enabled": await asyncio.to_thread(UsageLedger().observability_enabled, org)
    }


@router.put(
    "/observability",
    dependencies=[
        Depends(require_scopes(OAuthScopes.CONFIG_WRITE)),
        Depends(require_admin_caller),
    ],
)
async def set_observability(request: Request, body: ObservabilitySetting) -> dict:
    org, _ = caller(request)
    await asyncio.to_thread(
        UsageLedger().set_observability_enabled, org, enabled=body.enabled
    )
    return {"enabled": body.enabled}


@router.get("", dependencies=[Depends(require_scopes(OAuthScopes.ORG_READ))])
async def get_usage(
    request: Request,
    view: Literal["personal", "organization"] = "personal",
    audience: Literal["all", "users", "services"] = "all",
    start: datetime | None = Query(None, alias="from"),
    end: datetime | None = Query(None, alias="to"),
    interval: Literal["hour", "day", "week", "month"] = "day",
    provider: str = Query("", max_length=200),
    model: str = Query("", max_length=200),
    user_id: str = Query("", max_length=200),
    connector_id: str = Query("", max_length=200),
    workload: str = Query("", max_length=200),
    kind: str = Query("", max_length=200),
    status: str = Query("", max_length=200),
    offset: int = Query(0, ge=0, le=1_000_000),
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    org, own_user = await visibility(request, view)
    if audience != "all" and view != "organization":
        raise HTTPException(403, "Organization usage requires the administrator view")
    now = datetime.now(timezone.utc)
    start, end = start or now - timedelta(days=30), end or now
    if (
        start.tzinfo is None
        or end.tzinfo is None
        or not timedelta(0) < end - start <= timedelta(days=366)
    ):
        raise HTTPException(
            422, "Use a UTC date range of at most 366 days; the end is exclusive"
        )
    if interval == "hour" and end - start > timedelta(days=31):
        raise HTTPException(422, "Hourly reports are limited to 31 days")
    filters = {
        "audience": audience,
        "provider": provider,
        "model": model,
        "user_id": own_user or user_id,
        "connector_id": connector_id,
        "workload": workload,
        "kind": kind,
        "status": status,
    }
    report = await asyncio.to_thread(
        UsageLedger().report,
        org,
        timestamp(start),
        timestamp(end),
        filters,
        interval,
        offset,
        limit,
    )
    report["tracking_health"] = health()
    report["view"] = view
    return report


class Rates(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: Decimal = Field(ge=0, le=100_000, allow_inf_nan=False)
    output: Decimal = Field(ge=0, le=100_000, allow_inf_nan=False)
    cache_read: Decimal = Field(ge=0, le=100_000, allow_inf_nan=False)
    cache_write: Decimal = Field(ge=0, le=100_000, allow_inf_nan=False)


class RateUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=200)
    rates: Rates


class RateTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=200)


@router.delete(
    "/rates",
    dependencies=[
        Depends(require_scopes(OAuthScopes.CONFIG_WRITE)),
        Depends(require_admin_caller),
    ],
)
async def reset_rate(request: Request, body: RateTarget) -> dict:
    org, _ = caller(request)

    def remove() -> None:
        with UsageLedger().connection() as db:
            db.execute(
                "DELETE FROM usage_rates WHERE org_id=? AND provider=? AND model=?",
                (org, body.provider, body.model),
            )

    await asyncio.to_thread(remove)
    return {"saved": True, "applies_to": "future_events"}


@router.get(
    "/rates",
    dependencies=[
        Depends(require_scopes(OAuthScopes.CONFIG_READ)),
        Depends(require_admin_caller),
    ],
)
async def get_rates(request: Request) -> dict:
    org, _ = caller(request)
    return {
        "rates": await asyncio.to_thread(UsageLedger().rates, org),
        "currency": "USD",
        "unit": "per_million_tokens",
    }


@router.put(
    "/rates",
    dependencies=[
        Depends(require_scopes(OAuthScopes.CONFIG_WRITE)),
        Depends(require_admin_caller),
    ],
)
async def put_rate(request: Request, body: RateUpdate) -> dict:
    org, _ = caller(request)
    await asyncio.to_thread(
        UsageLedger().set_rate,
        org,
        body.provider,
        body.model,
        {key: str(value) for key, value in body.rates.model_dump().items()},
    )
    return {"saved": True, "applies_to": "future_events"}


class BudgetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: Literal["organization", "user_id", "connector_id", "model"]
    subject: str = Field("", max_length=200)
    amount_usd: Decimal = Field(
        ge=Decimal("0.000000001"), le=1_000_000_000, allow_inf_nan=False
    )
    warning_percent: int = Field(80, ge=1, le=100)


@router.get("/budgets", dependencies=[Depends(require_scopes(OAuthScopes.ORG_READ))])
async def get_budgets(
    request: Request, view: Literal["personal", "organization"] = "personal"
) -> dict:
    org, own_user = await visibility(request, view)
    return {
        "budgets": await asyncio.to_thread(UsageLedger().budgets, org, own_user),
        "period": "calendar_month_utc",
        "enforced": False,
    }


@router.put(
    "/budgets",
    dependencies=[
        Depends(require_scopes(OAuthScopes.CONFIG_WRITE)),
        Depends(require_admin_caller),
    ],
)
async def put_budget(request: Request, body: BudgetUpdate) -> dict:
    org, _ = caller(request)
    if body.scope != "organization" and not body.subject.strip():
        raise HTTPException(422, "Select the budget's member, connector or model")
    await asyncio.to_thread(
        UsageLedger().set_budget,
        org,
        body.scope,
        body.subject,
        body.amount_usd,
        body.warning_percent,
    )
    return {"saved": True, "enforced": False}


@router.delete(
    "/budgets/{budget_id}",
    dependencies=[
        Depends(require_scopes(OAuthScopes.CONFIG_WRITE)),
        Depends(require_admin_caller),
    ],
)
async def delete_budget(request: Request, budget_id: str) -> dict:
    org, _ = caller(request)

    def remove() -> bool:
        with UsageLedger().connection() as db:
            return (
                db.execute(
                    "DELETE FROM usage_budgets WHERE org_id=? AND id=?",
                    (org, budget_id),
                ).rowcount
                > 0
            )

    if not await asyncio.to_thread(remove):
        raise HTTPException(404, "Budget not found")
    return {"deleted": True}
