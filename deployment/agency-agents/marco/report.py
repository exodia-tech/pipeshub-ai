"""Prepare evidence for a reviewed maintenance report; no network or publication."""

import json
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


def instant(value: str) -> datetime:
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('Evidence timestamps must include a timezone')
    return value.astimezone(timezone.utc)


def report_window(anchor: str, index: int, timezone_name: str) -> tuple[datetime, datetime]:
    """A confirmed local anchor starts each 14-calendar-day reporting window."""
    zone = ZoneInfo(timezone_name)
    start = datetime.fromisoformat(anchor)
    if (
        start.tzinfo is not None
        or isinstance(index, bool)
        or not isinstance(index, int)
        or index < 0
    ):
        raise ValueError('Use a local anchor and non-negative period index')
    start = start + timedelta(days=14 * index)
    end = start + timedelta(days=14)
    def local_time(value: datetime) -> datetime:
        first = value.replace(tzinfo=zone, fold=0)
        second = value.replace(tzinfo=zone, fold=1)
        roundtrip = first.astimezone(timezone.utc).astimezone(zone)
        if first.utcoffset() != second.utcoffset() or roundtrip.replace(tzinfo=None) != value:
            raise ValueError('Reporting anchor must be an unambiguous local time')
        return first.astimezone(timezone.utc)

    return local_time(start), local_time(end)


def report_key(agreement_id: str, start: datetime, end: datetime) -> str:
    if not agreement_id or start.tzinfo is None or end.tzinfo is None or start >= end:
        raise ValueError('Agreement and valid report window are required')
    canonical = json.dumps((
        agreement_id,
        start.astimezone(timezone.utc).isoformat(),
        end.astimezone(timezone.utc).isoformat(),
    ), ensure_ascii=True, separators=(',', ':'))
    return sha256(canonical.encode()).hexdigest()


def build_report(
    agreement_id: str,
    start: datetime,
    end: datetime,
    as_of: datetime,
    sources: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Accept scoped, already-authorized evidence; do not infer delivery or billable time."""
    if any(dt.tzinfo is None for dt in (start, end, as_of)):
        raise ValueError('Use a completed window and timezone-aware as-of time')
    start, end, as_of = (dt.astimezone(timezone.utc) for dt in (start, end, as_of))
    if start >= end or as_of < end:
        raise ValueError('Use a completed window and timezone-aware as-of time')
    allowed_sources = {'linear', 'slack', 'hubstaff'}
    if set(sources) != allowed_sources:
        raise ValueError('Report all expected source availability explicitly')
    coverage, latest = {}, {}
    for source, result in sources.items():
        status = result.get('status')
        if status not in ('available', 'unavailable', 'partial'):
            raise ValueError('Source status must be available, unavailable or partial')
        records = result.get('records', [])
        if status == 'unavailable' and records:
            raise ValueError('Unavailable sources cannot return records')
        coverage[source] = status
        for record in records:
            if record.get('agreement_id') != agreement_id:
                raise ValueError('Evidence belongs to a different agreement')
            url = urlsplit(record.get('url', ''))
            if (
                not record.get('id') or url.scheme != 'https' or not url.hostname
                or url.username or url.password
            ):
                raise ValueError('Every record needs a stable ID and direct HTTPS citation')
            occurred = instant(record['occurred_at'])
            updated = instant(record['updated_at'])
            if updated > as_of:
                continue
            key = (source, record['id'])
            if (key in latest and latest[key][0] == updated
                    and latest[key][1] != record):
                raise ValueError('Conflicting evidence versions need manual reconciliation')
            if key not in latest or updated > latest[key][0]:
                latest[key] = (updated, record, occurred)

    items, seconds = [], 0
    for (source, _), (updated, record, occurred) in sorted(latest.items()):
        if source == 'hubstaff':
            stopped = instant(record['ended_at'])
            duration = record.get('seconds')
            if (stopped <= occurred or isinstance(duration, bool)
                    or not isinstance(duration, int) or duration < 0
                    or duration > (stopped - occurred).total_seconds()):
                raise ValueError('Time entries require non-negative recorded seconds')
            if stopped <= start or occurred >= end:
                continue
            if occurred < start or stopped > end:
                raise ValueError('A time entry crosses the window; reconcile it manually')
            seconds += duration
        else:
            if not start <= occurred < end:
                continue
            stages = {'discussed', 'planned', 'implemented', 'merged',
                      'deployed', 'verified', 'risk', 'decision'}
            if record.get('stage') not in stages:
                raise ValueError('Evidence needs an explicit stage')
        items.append({**record, 'source': source, 'late_or_revised': updated >= end})

    return {
        'report_key': report_key(agreement_id, start, end), 'agreement_id': agreement_id,
        'window_start': start.isoformat(), 'window_end_exclusive': end.isoformat(),
        'as_of': as_of.isoformat(), 'coverage': coverage, 'items': items,
        'recorded_seconds': seconds if coverage['hubstaff'] == 'available' else None,
        'billable_seconds': None,
    }
