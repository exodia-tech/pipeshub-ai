"""Content-free usage ledger for the single-host deployment; all services share its volume."""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from importlib.util import find_spec
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Iterator

NANO_USD = Decimal(1_000_000_000)
DIMENSIONS = (
    "provider",
    "model",
    "user_id",
    "connector_id",
    "workload",
    "kind",
    "status",
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_events (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, user_id TEXT, user_label TEXT,
 connector_id TEXT, agent_id TEXT, request_id TEXT, workload TEXT NOT NULL,
 kind TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
 input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
 cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
 reasoning_tokens INTEGER, measurement TEXT NOT NULL,
 duration_ms INTEGER NOT NULL, units INTEGER NOT NULL,
 cost_nano_usd INTEGER, pricing_source TEXT NOT NULL, pricing_snapshot TEXT
);
CREATE INDEX IF NOT EXISTS usage_org_time ON usage_events(org_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_user_time ON usage_events(org_id, user_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_connector_time ON usage_events(org_id, connector_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_model_time ON usage_events(org_id, model, occurred_at);
CREATE TABLE IF NOT EXISTS usage_rates (
 org_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 rates TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY (org_id, provider, model)
);
CREATE TABLE IF NOT EXISTS usage_budgets (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope TEXT NOT NULL,
 subject TEXT NOT NULL, amount_nano_usd INTEGER NOT NULL CHECK(amount_nano_usd>0), warning_percent INTEGER NOT NULL,
 updated_at TEXT NOT NULL, UNIQUE(org_id,scope,subject)
);
"""
_initialized: set[str] = set()
_initialize_lock = threading.Lock()


def initialize(db: sqlite3.Connection, path: str) -> None:
    with _initialize_lock:
        if path in _initialized:
            return
        deadline = time.monotonic() + 5
        while True:
            try:
                db.execute("PRAGMA journal_mode=WAL")
                db.executescript(SCHEMA)
                _initialized.add(path)
                return
            except sqlite3.OperationalError as error:
                if "locked" not in str(error).lower() or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)


def timestamp(value: datetime | None = None) -> str:
    return (
        (value or datetime.now(timezone.utc))
        .astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
    )


@lru_cache(maxsize=1)
def catalog() -> dict:
    # Read the installed, versioned fallback file, never fetch prices or import LiteLLM's network clients.
    spec = find_spec("litellm")
    if spec and spec.origin:
        path = Path(spec.origin).parent / "model_prices_and_context_window_backup.json"
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                logging.getLogger(__name__).warning(
                    "Local price catalog unavailable; events will remain unpriced"
                )
    return {}


def catalog_rates(provider: str, model: str) -> dict[str, str] | None:
    provider = provider.lower()
    if provider == "gemini" and model.startswith("models/"):
        model = model.removeprefix("models/")
    info = catalog().get(f"{provider}/{model}") or catalog().get(model)
    if not isinstance(info, dict):
        return None
    if "input_cost_per_token" not in info:
        return None
    if "output_cost_per_token" not in info and info.get("mode") != "embedding":
        return None
    names = {
        "input": "input_cost_per_token",
        "output": "output_cost_per_token",
        "cache_read": "cache_read_input_token_cost",
        "cache_write": "cache_creation_input_token_cost",
    }
    rates = {}
    for key, field in names.items():
        raw = info.get(
            field,
            0
            if key == "output" and info.get("mode") == "embedding"
            else info["input_cost_per_token"],
        )
        if raw is None:
            return None
        try:
            amount = Decimal(str(raw)) * 1_000_000
            if not amount.is_finite() or not 0 <= amount <= 100_000:
                return None
            rates[key] = str(amount)
        except ArithmeticError:
            return None
    # Tiered/long-context prices need an explicit administrator rate, not a misleading flat quote.
    if any("above" in key or "threshold" in key for key in info if "cost" in key):
        return None
    return rates


def price_nanos(event: dict, rates: dict[str, str]) -> int:
    regular = (
        event["input_tokens"] - event["cache_read_tokens"] - event["cache_write_tokens"]
    )
    counts = {
        "input": max(0, regular),
        "output": event["output_tokens"],
        "cache_read": event["cache_read_tokens"],
        "cache_write": event["cache_write_tokens"],
    }
    usd = sum(
        Decimal(count) * Decimal(rates[key]) / 1_000_000
        for key, count in counts.items()
    )
    return int((usd * NANO_USD).quantize(Decimal(1), rounding=ROUND_HALF_UP))


class UsageLedger:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.getenv("PIPESHUB_USAGE_DB", "")

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        if not self.path:
            raise RuntimeError(
                "Usage tracking requires PIPESHUB_USAGE_DB on persistent local storage"
            )
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            initialize(db, self.path)
            db.execute("PRAGMA synchronous=FULL")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def record(self, event: dict[str, Any]) -> None:
        if not event.get("org_id"):
            raise ValueError("Usage must belong to a verified organization")
        counts = (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
        )
        if any(
            type(event.get(k)) is not int or not 0 <= event[k] <= 100_000_000
            for k in counts
            if k != "reasoning_tokens" or event.get(k) is not None
        ):
            raise ValueError("Invalid token counts")
        if (
            event["cache_read_tokens"] + event["cache_write_tokens"]
            > event["input_tokens"]
        ):
            raise ValueError("Cache tokens are a subset of input tokens")
        if (event["reasoning_tokens"] or 0) > event["output_tokens"]:
            raise ValueError("Reasoning tokens are a subset of output tokens")
        e = {**event}
        e.setdefault("id", str(uuid.uuid4()))
        e.setdefault("occurred_at", timestamp())
        with self.connection() as db:
            row = db.execute(
                "SELECT rates FROM usage_rates WHERE org_id=? AND provider=? AND model=?",
                (e["org_id"], e["provider"], e["model"]),
            ).fetchone()
            rates = (
                json.loads(row[0]) if row else catalog_rates(e["provider"], e["model"])
            )
            e["pricing_source"] = (
                "custom" if row else "catalog" if rates else "unpriced"
            )
            e["cost_nano_usd"] = (
                price_nanos(e, rates)
                if rates and e["measurement"] != "unknown"
                else None
            )
            e["pricing_snapshot"] = json.dumps(rates, sort_keys=True) if rates else None
            allowed = [r[1] for r in db.execute("PRAGMA table_info(usage_events)")]
            values = {k: e.get(k) for k in allowed}
            db.execute(
                f"INSERT OR IGNORE INTO usage_events ({','.join(allowed)}) VALUES ({','.join('?' for _ in allowed)})",
                list(values.values()),
            )

    @staticmethod
    def _where(
        org: str, start: str, end: str, filters: dict[str, str]
    ) -> tuple[str, list]:
        parts, args = ["org_id=?", "occurred_at>=?", "occurred_at<?"], [org, start, end]
        for field in DIMENSIONS:
            if filters.get(field):
                if (
                    field in ("user_id", "connector_id")
                    and filters[field] == "__none__"
                ):
                    parts.append(f"{field} IS NULL")
                else:
                    parts.append(f"{field}=?")
                    args.append(filters[field])
        return " AND ".join(parts), args

    @staticmethod
    def _totals() -> str:
        return """COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens, CASE WHEN COUNT(reasoning_tokens)=COUNT(*) THEN SUM(reasoning_tokens) ELSE NULL END AS reasoning_tokens,
        COALESCE(SUM(cost_nano_usd),0)/1000000000.0 AS cost_usd,
        COALESCE(SUM(cost_nano_usd IS NULL),0) AS unpriced_requests,
        COALESCE(SUM(measurement='estimated'),0) AS estimated_requests,
        COALESCE(SUM(measurement='unknown'),0) AS unknown_requests,
        COALESCE(SUM(status!='success'),0) AS incomplete_requests,
        COALESCE(AVG(duration_ms),0) AS average_duration_ms, COALESCE(SUM(units),0) AS units"""

    def report(
        self,
        org: str,
        start: str,
        end: str,
        filters: dict[str, str],
        interval: str = "day",
        offset: int = 0,
        limit: int = 50,
    ) -> dict:
        where, args = self._where(org, start, end, filters)
        formats = {
            "hour": "%Y-%m-%dT%H:00:00Z",
            "day": "%Y-%m-%d",
            "week": "%Y-%m-%d",
            "month": "%Y-%m",
        }
        if (
            interval not in formats
            or not 0 <= offset <= 1_000_000
            or not 1 <= limit <= 200
        ):
            raise ValueError("Invalid report pagination or interval")
        with self.connection() as db:
            totals = self._totals()
            summary = dict(
                db.execute(
                    f"SELECT {totals} FROM usage_events WHERE {where}", args
                ).fetchone()
            )
            result = {
                "summary": summary,
                "currency": "USD",
                "timezone": "UTC",
                "from": start,
                "to": end,
            }
            bucket = (
                "date(occurred_at,'weekday 0','-6 days')"
                if interval == "week"
                else f"strftime('{formats[interval]}',occurred_at)"
            )
            actual = [
                dict(r)
                for r in db.execute(
                    f"SELECT {bucket} AS label, {totals} FROM usage_events WHERE {where} GROUP BY label ORDER BY label",
                    args,
                )
            ]
            indexed = {row["label"]: row for row in actual}
            current = datetime.fromisoformat(start).replace(
                tzinfo=timezone.utc, minute=0, second=0, microsecond=0
            )
            finish = datetime.fromisoformat(end).replace(tzinfo=timezone.utc)
            if interval != "hour":
                current = current.replace(hour=0)
            if interval == "week":
                current -= timedelta(days=current.weekday())
            if interval == "month":
                current = current.replace(day=1)
            result["timeline"] = []
            while current < finish:
                label = current.strftime(formats[interval])
                result["timeline"].append(
                    indexed.get(label, {**dict.fromkeys(summary, 0), "label": label})
                )
                current = (
                    (current.replace(day=28) + timedelta(days=4)).replace(day=1)
                    if interval == "month"
                    else current + timedelta(hours=1)
                    if interval == "hour"
                    else current + timedelta(days=7 if interval == "week" else 1)
                )
            for field in DIMENSIONS:
                label = (
                    "COALESCE(MAX(user_label),user_id,'Background services')"
                    if field == "user_id"
                    else f"COALESCE({field},'Unattributed')"
                )
                result[field] = [
                    dict(r)
                    for r in db.execute(
                        f"SELECT {field} AS id, {label} AS label, {totals} FROM usage_events WHERE {where} GROUP BY {field} ORDER BY requests DESC LIMIT 100",
                        args,
                    )
                ]
            rows = db.execute(
                f"SELECT * FROM usage_events WHERE {where} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?",
                [*args, limit, offset],
            ).fetchall()
            result["events"] = [
                {
                    k: v
                    for k, v in dict(r).items()
                    if k not in ("org_id", "pricing_snapshot", "cost_nano_usd")
                }
                | {
                    "cost_usd": r["cost_nano_usd"] / 1e9
                    if r["cost_nano_usd"] is not None
                    else None
                }
                for r in rows
            ]
            result["offset"], result["limit"] = offset, limit
            result["tracking_since"] = db.execute(
                "SELECT MIN(occurred_at) FROM usage_events WHERE org_id=?", (org,)
            ).fetchone()[0]
            return result

    def set_rate(
        self, org: str, provider: str, model: str, rates: dict[str, str]
    ) -> None:
        for key in ("input", "output", "cache_read", "cache_write"):
            amount = Decimal(rates[key])
            if not amount.is_finite() or not 0 <= amount <= 100_000:
                raise ValueError(
                    "Rates must be USD per million tokens, from 0 to 100000"
                )
        with self.connection() as db:
            db.execute(
                "INSERT INTO usage_rates VALUES (?,?,?,?,?) ON CONFLICT(org_id,provider,model) DO UPDATE SET rates=excluded.rates,updated_at=excluded.updated_at",
                (org, provider, model, json.dumps(rates, sort_keys=True), timestamp()),
            )

    def rates(self, org: str) -> list[dict]:
        with self.connection() as db:
            return [
                {
                    "provider": r["provider"],
                    "model": r["model"],
                    "rates": json.loads(r["rates"]),
                    "updated_at": r["updated_at"],
                }
                for r in db.execute(
                    "SELECT * FROM usage_rates WHERE org_id=? ORDER BY provider,model",
                    (org,),
                )
            ]

    def set_budget(
        self, org: str, scope: str, subject: str, amount: Decimal, warning: int
    ) -> None:
        if scope not in ("organization", "user_id", "connector_id", "model") or (
            scope != "organization" and not subject
        ):
            raise ValueError("A budget requires a valid scope and subject")
        if (
            not amount.is_finite()
            or not Decimal("0.000000001") <= amount <= 1_000_000_000
            or not 1 <= warning <= 100
        ):
            raise ValueError("Invalid budget")
        subject = "" if scope == "organization" else subject
        with self.connection() as db:
            db.execute(
                "INSERT INTO usage_budgets VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id,scope,subject) DO UPDATE SET amount_nano_usd=excluded.amount_nano_usd,warning_percent=excluded.warning_percent,updated_at=excluded.updated_at",
                (
                    str(uuid.uuid4()),
                    org,
                    scope,
                    subject,
                    int(amount * NANO_USD),
                    warning,
                    timestamp(),
                ),
            )

    def budgets(
        self, org: str, user_id: str | None = None, now: datetime | None = None
    ) -> list[dict]:
        current = now or datetime.now(timezone.utc)
        start = current.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        with self.connection() as db:
            rows = db.execute(
                "SELECT * FROM usage_budgets WHERE org_id=?", (org,)
            ).fetchall()
            result = []
            for r in rows:
                if user_id and (r["scope"] != "user_id" or r["subject"] != user_id):
                    continue
                filters = (
                    {} if r["scope"] == "organization" else {r["scope"]: r["subject"]}
                )
                where, args = self._where(
                    org, timestamp(start), timestamp(end), filters
                )
                totals = dict(
                    db.execute(
                        f"SELECT {self._totals()} FROM usage_events WHERE {where}", args
                    ).fetchone()
                )
                amount = r["amount_nano_usd"] / 1e9
                percent = totals["cost_usd"] / amount * 100
                result.append(
                    {
                        "id": r["id"],
                        "scope": r["scope"],
                        "subject": r["subject"],
                        "amount_usd": amount,
                        "warning_percent": r["warning_percent"],
                        "spent_usd": totals["cost_usd"],
                        "percent": percent,
                        "unpriced_requests": totals["unpriced_requests"],
                        "period_start": timestamp(start),
                        "period_end": timestamp(end),
                        "state": "exceeded"
                        if percent >= 100
                        else "warning"
                        if percent >= r["warning_percent"]
                        or totals["unpriced_requests"] > 0
                        else "within_budget",
                        "enforced": False,
                    }
                )
            return result
