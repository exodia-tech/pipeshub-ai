import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from app.services.usage.ledger import UsageLedger, price_nanos


def event(**changes: object) -> dict:
    return {
        "id": "call-1",
        "org_id": "org-a",
        "occurred_at": "2026-11-07T12:00:00.000+00:00",
        "provider": "test",
        "model": "model-a",
        "user_id": "user-a",
        "user_label": "Alice",
        "connector_id": "drive-1",
        "agent_id": None,
        "request_id": "request-a",
        "workload": "chat",
        "kind": "completion",
        "purpose": "main",
        "status": "success",
        "input_tokens": 100,
        "output_tokens": 50,
        "cache_read_tokens": 20,
        "cache_write_tokens": 10,
        "reasoning_tokens": 25,
        "measurement": "reported",
        "duration_ms": 100,
        "units": 1,
        **changes,
    }


class TestUsageLedger(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = UsageLedger(str(Path(self.temp.name) / "usage.db"))
        self.catalog = patch(
            "app.services.usage.ledger.catalog_rates", return_value=None
        )
        self.catalog.start()
        self.addCleanup(self.catalog.stop)
        self.rates = {
            "input": "2",
            "output": "6",
            "cache_read": "0.2",
            "cache_write": "2.5",
        }

    def report(self, org: str = "org-a", **filters: str) -> dict:
        return self.db.report(
            org,
            "2026-11-01T00:00:00.000+00:00",
            "2026-12-01T00:00:00.000+00:00",
            filters,
        )

    def test_cache_and_reasoning_are_subsets_not_extra_tokens(self) -> None:
        self.assertEqual(price_nanos(event(), self.rates), 469000)
        self.db.set_rate("org-a", "test", "model-a", self.rates)
        self.db.record(event())
        row = self.report()["summary"]
        self.assertAlmostEqual(row["cost_usd"], 0.000469)
        self.assertEqual((row["input_tokens"], row["output_tokens"]), (100, 50))

    def test_dedup_restart_and_tenant_isolation(self) -> None:
        self.assertIsNotNone(self.db.record(event()))
        self.assertIsNone(self.db.record(event()))
        self.db.record(event(id="other", org_id="org-b", user_id="user-a"))
        self.db = UsageLedger(self.db.path)
        self.assertEqual(self.report()["summary"]["requests"], 1)
        self.assertEqual(self.report("org-b")["summary"]["requests"], 1)
        self.assertEqual(self.report("org-c")["summary"]["requests"], 0)

    def test_unknown_price_stays_unknown_after_rate_changes(self) -> None:
        self.db.record(event())
        self.db.set_rate("org-a", "test", "model-a", self.rates)
        self.db.record(event(id="new"))
        self.db.set_rate("org-a", "test", "model-a", dict.fromkeys(self.rates, "99"))
        report = self.report()
        self.assertEqual(report["summary"]["unpriced_requests"], 1)
        self.assertAlmostEqual(report["summary"]["cost_usd"], 0.000469)
        self.assertIsNone(
            next(e for e in report["events"] if e["id"] == "call-1")["cost_usd"]
        )

    def test_personal_and_connector_filters_do_not_mix_members(self) -> None:
        self.db.record(event())
        self.db.record(
            event(id="bob", user_id="user-b", user_label="Bob", connector_id="slack-1")
        )
        self.db.record(event(id="background", user_id=None, user_label=None))
        report = self.report(user_id="user-a", connector_id="drive-1")
        self.assertEqual(report["summary"]["requests"], 1)
        self.assertEqual([r["id"] for r in report["user_id"]], ["user-a"])

    def test_monthly_budget_resets_and_never_hides_unpriced_calls(self) -> None:
        self.db.set_rate("org-a", "test", "model-a", self.rates)
        self.db.set_budget("org-a", "user_id", "user-a", Decimal("0.0005"), 80)
        self.db.record(event())
        self.db.record(event(id="unpriced", model="custom"))
        november = self.db.budgets(
            "org-a", "user-a", datetime(2026, 11, 8, tzinfo=timezone.utc)
        )[0]
        self.assertEqual(november["state"], "warning")
        self.assertFalse(november["enforced"])
        self.assertEqual(november["unpriced_requests"], 1)
        self.assertEqual(self.db.budgets("org-a", "user-b"), [])
        december = self.db.budgets(
            "org-a", now=datetime(2026, 12, 1, tzinfo=timezone.utc)
        )[0]
        self.assertEqual(december["spent_usd"], 0)
        self.db.record(event(id="over"))
        self.assertEqual(
            self.db.budgets("org-a", now=datetime(2026, 11, 8, tzinfo=timezone.utc))[0][
                "state"
            ],
            "exceeded",
        )

    def test_unpriced_budget_warns_and_sub_nanodollar_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.db.set_budget("org-a", "organization", "", Decimal("0.0000000001"), 80)
        self.db.set_budget("org-a", "organization", "", Decimal("100"), 80)
        self.db.record(event(reasoning_tokens=None))
        budget = self.db.budgets(
            "org-a", now=datetime(2026, 11, 8, tzinfo=timezone.utc)
        )[0]
        self.assertEqual(budget["state"], "warning")
        self.assertIsNone(self.report()["summary"]["reasoning_tokens"])

    def test_concurrent_writers_share_persistent_ledger(self) -> None:
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i: self.db.record(event(id=f"worker-{i}")), range(40)))
        self.assertEqual(self.report()["summary"]["requests"], 40)

    def test_bad_counts_and_rates_are_refused(self) -> None:
        for change in (
            {"input_tokens": -1},
            {"cache_read_tokens": 101},
            {"reasoning_tokens": 51},
            {"output_tokens": True},
        ):
            with self.assertRaises(ValueError):
                self.db.record(event(**change))
        for rate in ("NaN", "Infinity", "-1", "100001"):
            with self.assertRaises(ValueError):
                self.db.set_rate(
                    "org-a", "test", "model-a", {**self.rates, "input": rate}
                )

    def test_time_end_exclusive_and_pagination(self) -> None:
        self.db.record(event())
        self.db.record(event(id="last", occurred_at="2026-12-01T00:00:00.000+00:00"))
        self.assertEqual(self.report()["summary"]["requests"], 1)
        self.assertEqual(
            self.db.report("org-a", "2026-11-01", "2027-01-01", {}, limit=1, offset=1)[
                "events"
            ][0]["id"],
            "call-1",
        )
        with self.assertRaises(ValueError):
            self.db.report(
                "org-a", "a", "z", {}, interval="day'); DROP TABLE usage_events;--"
            )


if __name__ == "__main__":
    unittest.main()
