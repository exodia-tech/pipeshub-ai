from datetime import UTC, datetime, time, timedelta
from unittest import TestCase
from zoneinfo import ZoneInfo

from app.agents.proposal_workflow import (
    accept_source_edit,
    calendar_deadline,
    candidate_kind,
    capture_candidate,
    confirm,
    draft_report,
    missing_inputs,
    next_reminder,
    override_due,
    reconcile_source,
    set_reminder_result,
    set_state,
)

ZONE = ZoneInfo('Europe/Rome')
HOURS = {'working_start': time(9), 'working_end': time(18),
         'working_days': {0, 1, 2, 3, 4}}


def candidate(text='We will prepare a proposal', **overrides):
    source = dict(workspace_id='workspace', channel_id='private-channel',
                  message_id='123.456', message_revision='r1',
                  source_url='https://example.invalid/slack/123',
                  committed_at=datetime(2026, 11, 2, 10, tzinfo=ZONE),
                  text=text, source_access=True)
    source.update(overrides)
    return capture_candidate(**source)


def proposal():
    return confirm(candidate(), client_scope='client-1', owner_id='owner-1',
                   timezone='Europe/Rome', human_confirmed=True)


class ProposalWorkflowTest(TestCase):
    def test_detects_explicit_english_and_italian_but_flags_uncertainty(self):
        self.assertEqual(candidate_kind("We'll prepare a proposal"), 'explicit_review')
        self.assertEqual(candidate_kind('We will be doing a proposal'), 'explicit_review')
        self.assertEqual(candidate_kind("I'll draft a proposal"), 'explicit_review')
        self.assertEqual(candidate_kind('Prepareremo una proposta'), 'explicit_review')
        for message in ['Maybe we will prepare a proposal',
                        'We will not prepare a proposal',
                        'Will we prepare a proposal?', 'Forse faremo una proposta',
                        'We should discuss a proposal']:
            self.assertEqual(candidate_kind(message), 'ambiguous_review')
        self.assertIsNone(candidate('Hello team'))

    def test_acl_and_human_confirmation_are_required_and_source_is_stable(self):
        with self.assertRaises(PermissionError):
            candidate(source_access=False)
        with self.assertRaises(ValueError):
            candidate(committed_at=datetime(2026, 11, 2, 10))
        first, edit = candidate(), candidate(message_revision='r2')
        self.assertEqual(first.key, edit.key)
        self.assertNotEqual(first.key, candidate(channel_id='another').key)
        for values in [('', 'owner', True), ('client', '', True),
                       ('client', 'owner', False)]:
            with self.assertRaises(ValueError):
                confirm(first, client_scope=values[0], owner_id=values[1],
                        timezone='Europe/Rome', human_confirmed=values[2])
        self.assertEqual(proposal().candidate.source_url,
                         'https://example.invalid/slack/123')

    def test_seven_calendar_days_preserve_local_time_across_dst_and_weekend(self):
        start = datetime(2026, 3, 25, 10, tzinfo=ZONE)
        due = calendar_deadline(start, 'Europe/Rome')
        self.assertEqual(due, datetime(2026, 4, 1, 10, tzinfo=ZONE))
        self.assertEqual(due.astimezone(UTC) - start.astimezone(UTC),
                         timedelta(hours=167))
        friday = datetime(2026, 11, 6, 15, tzinfo=ZONE)
        self.assertEqual(calendar_deadline(friday, 'Europe/Rome'),
                         datetime(2026, 11, 13, 15, tzinfo=ZONE))
        with self.assertRaises(ValueError):
            calendar_deadline(datetime(2026, 3, 22, 2, 30, tzinfo=ZONE),
                              'Europe/Rome')

    def test_inputs_human_overrides_and_source_changes_are_preserved(self):
        item = proposal()
        self.assertEqual(len(missing_inputs(item)), 7)
        item.inputs['scope'] = 'Pilot delivery'
        self.assertNotIn('scope', missing_inputs(item))
        due = datetime(2026, 11, 16, 12, tzinfo=ZONE)
        override_due(item, due)
        self.assertEqual(item.due, due)
        self.assertEqual(item.original_due, datetime(2026, 11, 9, 10, tzinfo=ZONE))
        reconcile_source(item, 'r2')
        self.assertTrue(item.needs_reconciliation)
        self.assertIsNone(next_reminder(item, due, **HOURS))
        self.assertEqual(item.due, due)
        self.assertEqual(item.inputs['scope'], 'Pilot delivery')
        with self.assertRaises(ValueError):
            accept_source_edit(item, candidate(message_revision='r2'), human_verified=False)
        accept_source_edit(item, candidate(message_revision='r2'), human_verified=True)
        self.assertFalse(item.needs_reconciliation)
        with self.assertRaises(ValueError):
            override_due(item, datetime(2026, 11, 1, 10, tzinfo=ZONE))

    def test_draft_does_not_disclose_links_without_current_access(self):
        item = proposal()
        item.issue_url = 'https://example.invalid/private-issue'
        item.discovery_url = 'https://example.invalid/private-discovery'
        item.document_url = 'https://example.invalid/private-proposal'
        with self.assertRaises(PermissionError):
            draft_report(item, client_scope='other-client', source_access=True, issue_access=True,
                         discovery_access=True, document_access=True)
        with self.assertRaises(PermissionError):
            draft_report(item, client_scope='client-1', source_access=False, issue_access=True,
                         discovery_access=True, document_access=True)
        draft = draft_report(item, client_scope='client-1', source_access=True, issue_access=False,
                             discovery_access=False, document_access=False)
        self.assertIsNone(draft['discovery_url'])
        self.assertIsNone(draft['document_url'])
        self.assertIsNone(draft['issue_url'])
        allowed = draft_report(item, client_scope='client-1', source_access=True,
                               issue_access=True, discovery_access=True, document_access=True)
        self.assertEqual(allowed['issue_url'], item.issue_url)
        self.assertEqual(allowed['document_url'], item.document_url)
        self.assertEqual(draft['owner_id'], 'owner-1')
        self.assertEqual(len(draft['missing_inputs']), 7)

    def test_accelerated_full_week_coalesces_and_prevents_duplicate_or_uncertain_delivery(self):
        item = proposal()
        checks = [
            (datetime(2026, 11, 3, 10, tzinfo=ZONE), 'missing_inputs'),
            (datetime(2026, 11, 5, 10, tzinfo=ZONE), 'draft_progress'),
            # Days five and six land on the weekend; Monday coalesces them into deadline.
            (datetime(2026, 11, 7, 10, tzinfo=ZONE), None),
            (datetime(2026, 11, 9, 10, tzinfo=ZONE), 'deadline:0'),
            (datetime(2026, 11, 10, 10, tzinfo=ZONE), 'overdue:0:2026-11-10'),
        ]
        for now, expected in checks:
            result = next_reminder(item, now, **HOURS)
            self.assertEqual(result, expected)
            if result:
                set_reminder_result(item, result, 'reserved')
                self.assertIsNone(next_reminder(item, now, **HOURS))
                set_reminder_result(item, result, 'delivered')
                self.assertIsNone(next_reminder(item, now, **HOURS))
        set_reminder_result(item, 'overdue:0:2026-11-11', 'reserved')
        set_reminder_result(item, 'overdue:0:2026-11-11', 'uncertain')
        self.assertIsNone(next_reminder(item, datetime(2026, 11, 11, 10, tzinfo=ZONE), **HOURS))
        with self.assertRaises(ValueError):
            set_reminder_result(item, 'overdue:0:2026-11-11', 'reserved')
        with self.assertRaises(ValueError):
            override_due(item, datetime(2026, 11, 16, 10, tzinfo=ZONE))
        set_reminder_result(item, 'overdue:0:2026-11-11', 'delivered', human_reconciled=True)

    def test_deadline_override_keeps_history_and_schedules_the_new_deadline(self):
        item = proposal()
        set_reminder_result(item, 'deadline:0', 'reserved')
        set_reminder_result(item, 'deadline:0', 'delivered')
        new_due = datetime(2026, 11, 16, 10, tzinfo=ZONE)
        override_due(item, new_due)
        self.assertEqual(item.reminders['deadline:0'], 'delivered')
        self.assertEqual(next_reminder(item, new_due, **HOURS), 'deadline:1')

    def test_terminal_state_requires_verification_and_stops_reminders(self):
        for status in ['sent', 'cancelled']:
            item = proposal()
            with self.assertRaises(ValueError):
                set_state(item, status, human_verified=False)
            set_state(item, status, human_verified=True)
            self.assertIsNone(next_reminder(item, datetime(2026, 11, 10, 10, tzinfo=ZONE), **HOURS))
        item = proposal()
        self.assertIsNone(next_reminder(item, datetime(2026, 11, 3, 8, 59, tzinfo=ZONE), **HOURS))
