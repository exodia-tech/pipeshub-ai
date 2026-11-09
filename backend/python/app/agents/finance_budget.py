"""Pure finance calculations for the Alessio pilot; no source access or delivery."""

from collections.abc import Iterable
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any


def _amount(value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise ValueError("Use decimal strings or exact decimal amounts")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError("Invalid monetary value") from None
    if not result.is_finite() or result < 0:
        raise ValueError("Monetary values must be finite and non-negative")
    return result


def _latest(rows: list[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    """Reconcile overlapping pages by stable source ID and monotonically increasing revision."""
    result = {}
    for row in rows:
        identifier, revision = row["id"], row["revision"]
        if (
            not isinstance(identifier, str)
            or not identifier
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 0
        ):
            raise ValueError("A source ID and non-negative revision are required")
        previous = result.get(identifier)
        if previous and previous["revision"] == revision and previous != row:
            raise ValueError("Conflicting records with the same revision")
        if previous is None or revision > previous["revision"]:
            result[identifier] = row
    return result.values()


def calculate(snapshot: dict[str, Any], as_of: date) -> dict[str, Any]:
    """Compute a conservative project view from already-authorized, attributed records.

    Dates use an inclusive start and exclusive end; callers supply an as-of local date.
    Missing costs remain unknown. There is no currency conversion or payment inference.
    """
    if type(as_of) is not date:
        raise ValueError("An explicit reporting date is required")
    project, currency = snapshot["project_id"], snapshot["currency"]
    if (
        not project
        or not isinstance(currency, str)
        or len(currency) != 3
        or not currency.isascii()
        or not currency.isalpha()
        or not currency.isupper()
    ):
        raise ValueError("A project and ISO-style currency are required")
    start, end = (
        date.fromisoformat(snapshot["start"]),
        date.fromisoformat(snapshot["end"]),
    )
    if start >= end:
        raise ValueError("The reporting period must be nonempty")
    if snapshot.get("captured_on") != as_of.isoformat():
        raise ValueError("Supply a snapshot captured on the reporting date")
    if (
        snapshot.get("budget") is not None
        and snapshot.get("budget_currency") != currency
    ):
        raise ValueError("Budget currency must match the reporting currency")
    budget = None if snapshot.get("budget") is None else _amount(snapshot["budget"])
    rates = snapshot.get("cost_rates", [])
    labour = Decimal(0)
    missing = []
    pending = 0
    for entry in _latest(snapshot.get("time_entries", [])):
        day = date.fromisoformat(entry["date"])
        if entry["project_id"] != project or not (start <= day < end and day <= as_of):
            continue
        seconds = entry["seconds"]
        if not isinstance(seconds, int) or isinstance(seconds, bool) or seconds < 0:
            raise ValueError("Time duration must be non-negative whole seconds")
        if entry["approval"] == "rejected":
            continue
        if entry["approval"] != "approved":
            pending += 1
            missing.append("unapproved_time")
            continue
        candidates = [
            r
            for r in rates
            if r["member_id"] == entry["member_id"]
            and date.fromisoformat(r["from"]) <= day
            and (not r.get("to") or day < date.fromisoformat(r["to"]))
        ]
        if len(candidates) != 1 or candidates[0]["currency"] != currency:
            missing.append("missing_or_ambiguous_cost_rate")
            continue
        labour += (
            Decimal(seconds) * _amount(candidates[0]["hourly_cost"]) / Decimal(3600)
        )

    ai = Decimal(0)
    estimated = 0
    estimated_cost = Decimal(0)
    for event in _latest(snapshot.get("ai_usage", [])):
        day = date.fromisoformat(event["date"])
        if not (start <= day < end and day <= as_of):
            continue
        if event.get("project_id") is None:
            missing.append("unattributed_ai_usage")
            continue
        if event["project_id"] != project:
            continue
        if event.get("cost") is None or event.get("currency") != currency:
            missing.append("unpriced_or_other_currency_ai_usage")
            continue
        if event.get("estimated") is True:
            estimated_cost += _amount(event["cost"])
            estimated += 1
            missing.append("estimated_ai_cost")
        elif event.get("estimated") is False:
            ai += _amount(event["cost"])
        else:
            missing.append("unknown_ai_price_certainty")

    other = Decimal(0)
    for item in _latest(snapshot.get("other_costs", [])):
        day = date.fromisoformat(item["date"])
        if item["project_id"] != project or not (start <= day < end and day <= as_of):
            continue
        if (
            item.get("status") != "confirmed"
            or item.get("cost") is None
            or item.get("currency") != currency
        ):
            missing.append("unconfirmed_or_other_currency_cost")
            continue
        other += _amount(item["cost"])

    if snapshot.get("time_complete") is not True:
        missing.append("incomplete_time_source")
    if snapshot.get("ai_complete") is not True:
        missing.append("incomplete_ai_source")
    if snapshot.get("other_complete") is not True:
        missing.append("incomplete_other_cost_source")
    if snapshot.get("no_overlap_verified") is not True:
        missing.append("cost_overlap_not_reconciled")
    known = labour + ai + other
    complete = not missing
    actual = known if complete else None
    progress = snapshot.get("progress")
    forecast = None
    if progress is not None:
        progress = _amount(progress)
        if progress > 1:
            raise ValueError("Progress must be between zero and one")
        if complete and progress > 0:
            forecast = known / progress
    thresholds = [
        level
        for level in (70, 85, 100)
        if snapshot.get("no_overlap_verified") is True
        and budget is not None
        and budget > 0
        and known * 100 >= budget * level
    ]
    return {
        "project_id": project,
        "currency": currency,
        "as_of": as_of.isoformat(),
        "period": {"start": start.isoformat(), "end_exclusive": end.isoformat()},
        "budget": budget,
        "labour_known": labour,
        "ai_known": ai,
        "ai_estimated": estimated_cost,
        "other_known": other,
        "known_cost_lower_bound": known
        if snapshot.get("no_overlap_verified") is True
        else None,
        "actual_cost": actual,
        "remaining": budget - known if budget is not None and complete else None,
        "forecast_at_completion": forecast,
        "forecast_assumption": "linear cost versus supplied progress"
        if forecast is not None
        else None,
        "thresholds_reached_lower_bound": thresholds,
        "pending_time_entries": pending,
        "estimated_ai_entries": estimated,
        "missing": sorted(set(missing)),
    }


def due_items(
    invoices: list[dict[str, Any]], project_id: str, as_of: date, days_ahead: int
) -> dict[str, Any]:
    """Classify only confirmed open ledger entries; unknown status never means unpaid."""
    if (
        not project_id
        or type(as_of) is not date
        or not isinstance(days_ahead, int)
        or isinstance(days_ahead, bool)
        or days_ahead < 0
    ):
        raise ValueError("Provide an as-of date and a non-negative reminder window")
    results = []
    unknown = 0
    for item in _latest(invoices):
        if item.get("project_id") != project_id:
            continue
        if item.get("status") not in ("open", "paid", "void") or (
            item.get("status") == "open"
            and (
                not item.get("due_date")
                or item.get("kind") not in ("receivable", "obligation")
            )
        ):
            unknown += 1
            continue
        if item["status"] != "open":
            continue
        due = date.fromisoformat(item["due_date"])
        if due < as_of:
            state = "overdue"
        elif due <= as_of + timedelta(days=days_ahead):
            state = "due_soon"
        else:
            continue
        results.append(
            {
                "id": item["id"],
                "kind": item["kind"],
                "due_date": due.isoformat(),
                "state": state,
                "source_url": item.get("source_url"),
            }
        )
    return {
        "items": sorted(results, key=lambda item: (item["due_date"], item["id"])),
        "unknown_count": unknown,
    }
