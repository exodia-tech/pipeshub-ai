import unittest
from copy import deepcopy
from datetime import date
from decimal import Decimal

from app.agents.finance_budget import calculate, due_items


class FinanceBudgetTest(unittest.TestCase):
    def setUp(self) -> None:
        self.as_of = date(2026, 11, 9)
        self.data = {
            "project_id": "synthetic-project",
            "currency": "EUR",
            "budget": "1000",
            "budget_currency": "EUR",
            "captured_on": "2026-11-09",
            "start": "2026-11-01",
            "end": "2026-12-01",
            "time_complete": True,
            "ai_complete": True,
            "other_complete": True,
            "no_overlap_verified": True,
            "cost_rates": [
                {
                    "member_id": "m1",
                    "from": "2026-11-01",
                    "to": "2026-11-05",
                    "hourly_cost": "80",
                    "currency": "EUR",
                },
                {
                    "member_id": "m1",
                    "from": "2026-11-05",
                    "hourly_cost": "100",
                    "currency": "EUR",
                },
            ],
            "time_entries": [
                {
                    "id": "a",
                    "revision": 1,
                    "project_id": "synthetic-project",
                    "member_id": "m1",
                    "date": "2026-11-03",
                    "seconds": 3600,
                    "approval": "approved",
                },
                {
                    "id": "b",
                    "revision": 1,
                    "project_id": "synthetic-project",
                    "member_id": "m1",
                    "date": "2026-11-08",
                    "seconds": 7200,
                    "approval": "approved",
                },
            ],
            "ai_usage": [
                {
                    "id": "u1",
                    "revision": 1,
                    "project_id": "synthetic-project",
                    "date": "2026-11-08",
                    "cost": "20",
                    "currency": "EUR",
                    "estimated": False,
                }
            ],
            "progress": "0.5",
        }

    def test_rate_changes_late_revision_and_duplicate_page(self) -> None:
        self.data["time_entries"] += [
            deepcopy(self.data["time_entries"][0]),
            {**self.data["time_entries"][1], "revision": 2, "seconds": 10800},
        ]
        report = calculate(self.data, self.as_of)
        self.assertEqual(report["labour_known"], Decimal("380"))
        self.assertEqual(report["actual_cost"], Decimal("400"))
        self.assertEqual(report["remaining"], Decimal("600"))
        self.assertEqual(report["forecast_at_completion"], Decimal("800"))
        self.assertEqual(
            report["forecast_assumption"], "linear cost versus supplied progress"
        )
        conflict = {**self.data["time_entries"][0], "seconds": 7200}
        self.data["time_entries"].append(conflict)
        with self.assertRaises(ValueError):
            calculate(self.data, self.as_of)

    def test_unapproved_unpriced_estimated_and_unattributed_are_not_zero(self) -> None:
        self.data["time_entries"].append(
            {**self.data["time_entries"][0], "id": "pending", "approval": "pending"}
        )
        self.data["ai_usage"] += [
            {
                "id": "u2",
                "revision": 1,
                "project_id": "synthetic-project",
                "date": "2026-11-08",
                "cost": None,
                "currency": "EUR",
            },
            {
                "id": "u3",
                "revision": 1,
                "project_id": "synthetic-project",
                "date": "2026-11-08",
                "cost": "100",
                "currency": "EUR",
                "estimated": True,
            },
            {
                "id": "u4",
                "revision": 1,
                "project_id": None,
                "date": "2026-11-08",
                "cost": "40",
                "currency": "EUR",
            },
        ]
        report = calculate(self.data, self.as_of)
        self.assertEqual(report["known_cost_lower_bound"], Decimal("300"))
        self.assertEqual(report["ai_estimated"], Decimal("100"))
        self.assertEqual(report["pending_time_entries"], 1)
        for field in ("actual_cost", "remaining", "forecast_at_completion"):
            self.assertIsNone(report[field])
        self.assertEqual(
            set(report["missing"]),
            {
                "unapproved_time",
                "unpriced_or_other_currency_ai_usage",
                "estimated_ai_cost",
                "unattributed_ai_usage",
            },
        )

    def test_currency_mismatch_incomplete_sources_and_conflicting_rate_are_unknown(
        self,
    ) -> None:
        self.data["cost_rates"][1]["currency"] = "USD"
        self.data["time_complete"] = False
        self.data["ai_usage"][0]["currency"] = "USD"
        report = calculate(self.data, self.as_of)
        self.assertEqual(report["known_cost_lower_bound"], Decimal("80"))
        self.assertIsNone(report["actual_cost"])
        self.assertIn("missing_or_ambiguous_cost_rate", report["missing"])
        self.assertIn("incomplete_time_source", report["missing"])
        self.assertIn("unpriced_or_other_currency_ai_usage", report["missing"])
        self.data["cost_rates"].append(
            {**self.data["cost_rates"][0], "hourly_cost": "100"}
        )
        self.assertIn(
            "missing_or_ambiguous_cost_rate",
            calculate(self.data, self.as_of)["missing"],
        )

    def test_thresholds_exact_and_partial_data_never_invent_a_forecast(self) -> None:
        self.data["budget"] = "400"
        report = calculate(self.data, self.as_of)
        self.assertEqual(report["thresholds_reached_lower_bound"], [70])
        self.data["budget"] = "300"
        self.assertEqual(
            calculate(self.data, self.as_of)["thresholds_reached_lower_bound"],
            [70, 85, 100],
        )
        self.data["ai_complete"] = False
        report = calculate(self.data, self.as_of)
        self.assertEqual(report["thresholds_reached_lower_bound"], [70, 85, 100])
        self.assertIsNone(report["forecast_at_completion"])
        self.data["budget"] = "0"
        self.assertEqual(
            calculate(self.data, self.as_of)["thresholds_reached_lower_bound"], []
        )

    def test_date_boundaries_project_isolation_and_invalid_inputs(self) -> None:
        self.data["time_entries"] += [
            {**self.data["time_entries"][0], "id": "future", "date": "2026-11-10"},
            {**self.data["time_entries"][0], "id": "other", "project_id": "other"},
            {**self.data["time_entries"][0], "id": "rejected", "approval": "rejected"},
        ]
        self.assertEqual(
            calculate(self.data, self.as_of)["actual_cost"], Decimal("300")
        )
        for field, value in [
            ("budget", "NaN"),
            ("budget", 0.1),
            ("progress", "1.1"),
            ("currency", "US1"),
            ("budget_currency", "USD"),
            ("captured_on", "2026-11-10"),
        ]:
            bad = deepcopy(self.data)
            bad[field] = value
            with self.assertRaises(ValueError):
                calculate(bad, self.as_of)

    def test_other_costs_and_unverified_overlap_do_not_create_false_totals_or_alerts(
        self,
    ) -> None:
        self.data["other_costs"] = [
            {
                "id": "o1",
                "revision": 1,
                "project_id": "synthetic-project",
                "date": "2026-11-08",
                "status": "confirmed",
                "cost": "500",
                "currency": "EUR",
            }
        ]
        report = calculate(self.data, self.as_of)
        self.assertEqual(report["actual_cost"], Decimal("800"))
        self.assertEqual(report["thresholds_reached_lower_bound"], [70])
        self.data["no_overlap_verified"] = False
        report = calculate(self.data, self.as_of)
        self.assertIsNone(report["actual_cost"])
        self.assertIsNone(report["known_cost_lower_bound"])
        self.assertEqual(report["thresholds_reached_lower_bound"], [])
        self.assertIn("cost_overlap_not_reconciled", report["missing"])
        self.data["no_overlap_verified"] = True
        self.data["other_costs"][0]["status"] = "estimated"
        self.assertIn(
            "unconfirmed_or_other_currency_cost",
            calculate(self.data, self.as_of)["missing"],
        )

    def test_due_dates_require_confirmed_open_status(self) -> None:
        invoices = [
            {
                "id": "a",
                "revision": 1,
                "status": "open",
                "due_date": "2026-11-08",
                "source_url": "https://example.invalid/a",
            },
            {"id": "b", "revision": 1, "status": "open", "due_date": "2026-11-12"},
            {"id": "c", "revision": 1, "status": "unknown", "due_date": "2026-11-01"},
            {"id": "d", "revision": 1, "status": "paid", "due_date": "2026-11-01"},
            {"id": "e", "revision": 1, "status": "open", "due_date": "2026-11-30"},
            {
                "id": "a",
                "revision": 1,
                "status": "open",
                "due_date": "2026-11-08",
                "source_url": "https://example.invalid/a",
            },
        ]
        invoices = [
            {**item, "project_id": "synthetic-project", "kind": "receivable"}
            for item in invoices
        ]
        invoices.append(
            {
                "id": "foreign",
                "revision": 1,
                "project_id": "other",
                "kind": "obligation",
                "status": "open",
                "due_date": "2026-11-01",
            }
        )
        result = due_items(invoices, "synthetic-project", self.as_of, 7)
        items = result["items"]
        self.assertEqual(result["unknown_count"], 1)
        self.assertEqual(
            [(item["id"], item["state"]) for item in items],
            [("a", "overdue"), ("b", "due_soon")],
        )
        self.assertEqual(items[0]["source_url"], "https://example.invalid/a")
        invoices.append(
            {
                "id": "a",
                "revision": 2,
                "project_id": "synthetic-project",
                "status": "paid",
                "due_date": "2026-11-08",
            }
        )
        self.assertEqual(
            [
                item["id"]
                for item in due_items(invoices, "synthetic-project", self.as_of, 7)[
                    "items"
                ]
            ],
            ["b"],
        )


if __name__ == "__main__":
    unittest.main()
