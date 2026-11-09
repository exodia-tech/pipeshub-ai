"""Offline proposal rules; the authorized runtime owns storage and side effects."""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

_COMMITMENT = re.compile(
    r"\b(?:we(?:'ll| will)|i(?:'ll| will)|we are going to)\s+"
    r"(?:be\s+)?(?:prepare|preparing|draft|drafting|write|writing|"
    r"make|making|do|doing|send|sending)\s+(?:a |the |our )?proposal\b"
    r"|\b(?:prepareremo|redigeremo|invieremo|faremo)\s+"
    r"(?:una |la |un'?)?proposta\b",
    re.IGNORECASE,
)
_UNCERTAIN = re.compile(
    r"\b(?:not|won't|will not|maybe|might|could|if|unless|perhaps|"
    r"non|forse|potremmo|se|qualora)\b|\?",
    re.IGNORECASE,
)
_STEPS = ((1, 'missing_inputs'), (3, 'draft_progress'),
          (5, 'internal_review'), (6, 'readiness'))
_TERMINAL = {'sent', 'cancelled'}
_STATES = {'information_needed', 'drafting', 'internal_review', 'ready',
           *_TERMINAL}
REQUIRED_INPUTS = ('outcomes', 'scope', 'assumptions', 'deliverables',
                   'estimate_pricing', 'decision_makers', 'next_meeting')


def candidate_kind(text: str) -> str:
    """Classify for human review, never create an obligation from text alone."""
    if not text.strip():
        return 'none'
    if _COMMITMENT.search(text) and not _UNCERTAIN.search(text):
        return 'explicit_review'
    if re.search(r'\b(?:proposal|proposta|preventivo)\b', text, re.IGNORECASE):
        return 'ambiguous_review'
    return 'none'


def _aware(value: datetime) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('A timezone-aware timestamp is required')


def calendar_deadline(commitment: datetime, timezone: str) -> datetime:
    """Seven calendar days at the same local time; ambiguous DST needs review."""
    _aware(commitment)
    zone = ZoneInfo(timezone)
    local = commitment.astimezone(zone)
    wall = local.replace(tzinfo=None) + timedelta(days=7)
    early, late = wall.replace(tzinfo=zone, fold=0), wall.replace(tzinfo=zone, fold=1)
    if early.utcoffset() != late.utcoffset():
        raise ValueError('Deadline falls in a DST gap or overlap; choose it manually')
    if early.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != wall:
        raise ValueError('Deadline is not a valid local time')
    return early


@dataclass(frozen=True)
class Candidate:
    workspace_id: str
    channel_id: str
    message_id: str
    message_revision: str
    source_url: str
    committed_at: datetime
    classification: str

    @property
    def key(self) -> tuple[str, str, str]:
        return self.workspace_id, self.channel_id, self.message_id


def capture_candidate(*, workspace_id: str, channel_id: str, message_id: str,
                      message_revision: str, source_url: str, committed_at: datetime,
                      text: str, source_access: bool) -> Candidate | None:
    """The caller must revalidate source ACLs before passing source content."""
    if not source_access:
        raise PermissionError('Source is not authorized')
    _aware(committed_at)
    if not all(value.strip() for value in
               (workspace_id, channel_id, message_id, message_revision, source_url)):
        raise ValueError('Source identity, revision and link are required')
    kind = candidate_kind(text)
    if kind == 'none':
        return None
    return Candidate(workspace_id, channel_id, message_id, message_revision,
                     source_url, committed_at, kind)


@dataclass
class Proposal:
    candidate: Candidate
    client_scope: str
    owner_id: str
    timezone: str
    original_due: datetime
    state: str = 'information_needed'
    due_override: datetime | None = None
    deadline_revision: int = 0
    issue_url: str | None = None
    discovery_url: str | None = None
    document_url: str | None = None
    inputs: dict[str, str] = field(default_factory=dict)
    reminders: dict[str, str] = field(default_factory=dict)
    needs_reconciliation: bool = False

    @property
    def due(self) -> datetime:
        return self.due_override or self.original_due


def confirm(candidate: Candidate, *, client_scope: str, owner_id: str,
            timezone: str, human_confirmed: bool) -> Proposal:
    if not human_confirmed or not client_scope.strip() or not owner_id.strip():
        raise ValueError('A human must confirm the client, owner and commitment')
    return Proposal(candidate, client_scope, owner_id, timezone,
                    calendar_deadline(candidate.committed_at, timezone))


def override_due(proposal: Proposal, due: datetime) -> None:
    _aware(due)
    if due.astimezone(UTC) < proposal.candidate.committed_at.astimezone(UTC):
        raise ValueError('The deadline cannot precede the commitment')
    if any(s in {'reserved', 'uncertain'} for s in proposal.reminders.values()):
        raise ValueError('Reconcile the delivery before changing the deadline')
    if due.astimezone(UTC) != proposal.due.astimezone(UTC):
        proposal.deadline_revision += 1
    proposal.due_override = due


def set_state(proposal: Proposal, state: str, *, human_verified: bool) -> None:
    if state not in _STATES:
        raise ValueError('Unknown proposal state')
    if state in _TERMINAL and not human_verified:
        raise ValueError('Sent and cancelled require human verification')
    proposal.state = state


def reconcile_source(proposal: Proposal, revision: str | None) -> None:
    if revision != proposal.candidate.message_revision:
        proposal.needs_reconciliation = True


def accept_source_edit(proposal: Proposal, candidate: Candidate,
                       *, human_verified: bool) -> None:
    if (not human_verified or candidate.key != proposal.candidate.key
            or candidate.committed_at != proposal.candidate.committed_at):
        raise ValueError('A human must verify the same source and commitment time')
    proposal.candidate = candidate
    proposal.needs_reconciliation = False


def missing_inputs(proposal: Proposal) -> list[str]:
    return [name for name in REQUIRED_INPUTS
            if not proposal.inputs.get(name, '').strip()]


def draft_report(proposal: Proposal, *, client_scope: str, source_access: bool,
                 issue_access: bool, discovery_access: bool,
                 document_access: bool) -> dict:
    """The runtime supplies freshly verified source and client permissions."""
    if not source_access or client_scope != proposal.client_scope:
        raise PermissionError('The caller cannot read this proposal source')
    return {
        'owner_id': proposal.owner_id,
        'state': proposal.state,
        'source_url': proposal.candidate.source_url,
        'due': proposal.due.isoformat(),
        'timezone': proposal.timezone,
        'issue_url': proposal.issue_url if issue_access else None,
        'discovery_url': proposal.discovery_url if discovery_access else None,
        'document_url': proposal.document_url if document_access else None,
        'missing_inputs': missing_inputs(proposal),
        'needs_reconciliation': proposal.needs_reconciliation,
    }


def next_reminder(proposal: Proposal, now: datetime, *, working_start: time,
                  working_end: time, working_days: set[int]) -> str | None:
    """Coalesce missed milestones; caller atomically records delivery results."""
    _aware(now)
    if proposal.state in _TERMINAL or proposal.needs_reconciliation:
        return None
    if (not working_days or not working_days <= set(range(7))
            or working_start.tzinfo is not None or working_end.tzinfo is not None
            or not working_start < working_end):
        raise ValueError('Specify business days and a valid working-hours window')
    local = now.astimezone(ZoneInfo(proposal.timezone))
    if (local.weekday() not in working_days
            or not working_start <= local.time() < working_end):
        return None
    if any(s in {'reserved', 'uncertain'} for s in proposal.reminders.values()):
        return None
    start = proposal.candidate.committed_at.astimezone(ZoneInfo(proposal.timezone))
    due = proposal.due.astimezone(ZoneInfo(proposal.timezone))
    elapsed = [name for day, name in _STEPS
               if min(start + timedelta(days=day), due) <= local]
    deadline_key = f'deadline:{proposal.deadline_revision}'
    if local >= due:
        elapsed.append(deadline_key)
    if not elapsed:
        return None
    milestone = elapsed[-1]
    if (milestone == deadline_key
            and proposal.reminders.get(deadline_key) == 'delivered'
            and local.date() > due.date()):
        milestone = f'overdue:{proposal.deadline_revision}:{local.date().isoformat()}'
    return None if proposal.reminders.get(milestone) == 'delivered' else milestone


def set_reminder_result(proposal: Proposal, milestone: str, result: str,
                        *, human_reconciled: bool = False) -> None:
    valid_deadline = re.fullmatch(
        r'deadline:\d+|overdue:\d+:\d{4}-\d{2}-\d{2}', milestone)
    if milestone not in {name for _, name in _STEPS} and not valid_deadline:
        raise ValueError('Unknown reminder milestone')
    if result not in {'reserved', 'delivered', 'uncertain'}:
        raise ValueError('Unknown delivery status')
    previous = proposal.reminders.get(milestone)
    if result == 'reserved' and previous is not None:
        raise ValueError('This reminder has already been claimed')
    if result in {'delivered', 'uncertain'} and previous != 'reserved':
        if not (human_reconciled and previous == 'uncertain' and result == 'delivered'):
            raise ValueError('Delivery needs a reservation or human reconciliation')
    proposal.reminders[milestone] = result
