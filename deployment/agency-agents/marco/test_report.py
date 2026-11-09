import unittest
from datetime import datetime, timezone

from report import build_report, report_key, report_window


def utc(value):
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def entry(source_id, occurred, updated, **fields):
    return {'id': source_id, 'agreement_id': 'client-a', 'url': f'https://example.invalid/{source_id}',
            'occurred_at': occurred, 'updated_at': updated, **fields}


class MaintenanceReportTest(unittest.TestCase):
    def setUp(self):
        self.start = utc('2026-10-25T00:00:00')
        self.end = utc('2026-11-08T00:00:00')
        self.as_of = utc('2026-11-10T00:00:00')
        self.sources = {'linear': {'status': 'available', 'records': []},
                        'slack': {'status': 'available', 'records': []},
                        'hubstaff': {'status': 'available', 'records': []}}

    def test_windows_follow_local_time_across_dst(self):
        start, end = report_window('2026-10-18T09:00:00', 0, 'Europe/Rome')
        self.assertEqual(start.isoformat(), '2026-10-18T07:00:00+00:00')
        self.assertEqual(end.isoformat(), '2026-11-01T08:00:00+00:00')
        self.assertEqual(report_key('client-a', start, end), report_key('client-a', start, end))
        self.assertNotEqual(report_key('client-a', start, end), report_key('client-b', start, end))
        with self.assertRaises(ValueError): report_window('2026-10-25T02:30:00', 0, 'Europe/Rome')
        with self.assertRaises(ValueError): report_window('2026-03-29T02:30:00', 0, 'Europe/Rome')
        with self.assertRaises(ValueError): report_window('2026-10-18T09:00:00', True, 'Europe/Rome')

    def test_deduplicates_corrections_flags_late_and_excludes_boundary(self):
        self.sources['hubstaff']['records'] = [
            entry('time-1', '2026-11-01T12:00:00Z', '2026-11-02T12:00:00Z', seconds=1800),
            entry('time-1', '2026-11-01T12:00:00Z', '2026-11-09T12:00:00Z', seconds=2400),
            entry('time-2', '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z', seconds=3600),
            entry('time-3', '2026-11-01T12:00:00Z', '2026-11-11T12:00:00Z', seconds=3600),
        ]
        self.sources['linear']['records'] = [entry('issue-1', '2026-11-02T12:00:00Z', '2026-11-02T12:00:00Z', stage='merged')]
        report = build_report('client-a', self.start, self.end, self.as_of, self.sources)
        self.assertEqual(report['recorded_seconds'], 2400)
        self.assertIsNone(report['billable_seconds'])
        self.assertEqual({x['id'] for x in report['items']}, {'time-1', 'issue-1'})
        self.assertTrue(next(x for x in report['items'] if x['id'] == 'time-1')['late_or_revised'])
        self.assertEqual(next(x for x in report['items'] if x['id'] == 'issue-1')['stage'], 'merged')

    def test_outage_and_partial_time_are_unknown_not_zero(self):
        for status in ('unavailable', 'partial'):
            self.sources['hubstaff']['status'] = status
            result = build_report('client-a', self.start, self.end, self.as_of, self.sources)
            self.assertIsNone(result['recorded_seconds'])
            self.assertEqual(result['coverage']['hubstaff'], status)

    def test_refuses_cross_client_missing_stage_and_conflicting_versions(self):
        other = entry('foreign', '2026-11-01T12:00:00Z', '2026-11-02T12:00:00Z', stage='discussed')
        other['agreement_id'] = 'client-b'
        self.sources['slack']['records'] = [other]
        with self.assertRaises(ValueError): build_report('client-a', self.start, self.end, self.as_of, self.sources)
        other['agreement_id'] = 'client-a'; del other['stage']
        with self.assertRaises(ValueError): build_report('client-a', self.start, self.end, self.as_of, self.sources)
        other['stage'] = 'discussed'
        self.sources['slack']['records'].append({**other, 'stage': 'verified'})
        with self.assertRaises(ValueError): build_report('client-a', self.start, self.end, self.as_of, self.sources)


if __name__ == '__main__':
    unittest.main()
