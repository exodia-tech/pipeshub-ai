import tempfile
import unittest
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from starlette.responses import Response
from test_ledger import event

from app.api.routes import usage
from app.services.usage.ledger import UsageLedger, catalog_rates


class TestUsageRoutes(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = str(Path(self.temp.name) / "ledger.db")
        env = patch.dict("os.environ", {"PIPESHUB_USAGE_DB": path})
        env.start()
        self.addCleanup(env.stop)
        catalog = patch("app.services.usage.ledger.catalog_rates", return_value=None)
        catalog.start()
        self.addCleanup(catalog.stop)
        self.db = UsageLedger(path)
        self.db.record(event())
        self.db.record(event(id="bob", user_id="user-b", user_label="Bob"))
        self.db.record(event(id="other-tenant", org_id="org-b"))
        self.user = {"orgId": "org-a", "userId": "user-a", "role": "member"}
        app = FastAPI()

        @app.middleware("http")
        async def verified_caller(
            request: Request, call_next: Callable[[Request], Awaitable[Response]]
        ) -> Response:
            # The real middleware verifies signatures and revocation; these tests exercise routing after verification.
            if self.user is not None:
                request.state.user = self.user
            return await call_next(request)

        async def authoritative_admin(request: Request) -> None:
            if (getattr(request.state, "user", None) or {}).get("role") != "admin":
                raise HTTPException(403, "Administrator required")

        original_admin = usage.require_admin_caller
        admin = patch.object(usage, "require_admin_caller", authoritative_admin)
        admin.start()
        self.addCleanup(admin.stop)
        app.dependency_overrides[original_admin] = authoritative_admin
        app.include_router(usage.router, prefix="/api/v1")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def get(self, **params: object) -> httpx.Response:
        return self.client.get(
            "/api/v1/usage",
            params={
                "from": "2026-11-01T00:00:00Z",
                "to": "2026-12-01T00:00:00Z",
                **params,
            },
        )

    def test_personal_view_forces_verified_user_and_org(self) -> None:
        response = self.get(user_id="user-b", org_id="org-b")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["summary"]["requests"], 1)
        self.assertEqual(response.json()["events"][0]["user_id"], "user-a")

    def test_observability_requires_admin_and_is_org_scoped(self) -> None:
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/observability", json={"enabled": True}
            ).status_code,
            403,
        )
        self.user["role"] = "admin"
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/observability", json={"enabled": "true"}
            ).status_code,
            422,
        )
        self.assertEqual(
            self.client.get("/api/v1/usage/observability").json(), {"enabled": False}
        )
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/observability", json={"enabled": True}
            ).json(),
            {"enabled": True},
        )
        self.assertTrue(self.db.observability_enabled("org-a"))
        self.assertFalse(self.db.observability_enabled("org-b"))
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/observability", json={"enabled": False}
            ).status_code,
            200,
        )
        self.assertFalse(self.db.observability_enabled("org-a"))

    def test_member_cannot_read_org_or_write_budget_or_price(self) -> None:
        self.assertEqual(self.get(view="organization").status_code, 403)
        self.assertEqual(self.client.get("/api/v1/usage/rates").status_code, 403)
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/budgets",
                json={"scope": "organization", "amount_usd": 10},
            ).status_code,
            403,
        )

    def test_admin_sees_only_own_org_and_tenant_scopes_budget_deletion(self) -> None:
        self.user["role"] = "admin"
        self.assertEqual(self.get(view="organization").json()["summary"]["requests"], 2)
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/budgets",
                json={"scope": "organization", "amount_usd": "10"},
            ).status_code,
            200,
        )
        budget = self.client.get("/api/v1/usage/budgets?view=organization").json()[
            "budgets"
        ][0]
        self.user["orgId"] = "org-b"
        self.assertEqual(
            self.client.delete(f"/api/v1/usage/budgets/{budget['id']}").status_code, 404
        )

    def test_budget_lifecycle_and_gemini_embedding_spend(self) -> None:
        self.user["role"] = "admin"
        payload = {
            "scope": "organization",
            "subject": "",
            "amount_usd": "0.0001",
            "warning_percent": 80,
        }
        self.assertEqual(
            self.client.put("/api/v1/usage/budgets", json=payload).status_code, 200
        )
        catalog = {
            "gemini/gemini-embedding-2": {
                "input_cost_per_token": 0.0000002,
                "output_cost_per_token": 0,
                "mode": "embedding",
            }
        }
        with (
            patch("app.services.usage.ledger.catalog", return_value=catalog),
            patch("app.services.usage.ledger.catalog_rates", new=catalog_rates),
        ):
            self.db.record(
                event(
                    id="gemini",
                    occurred_at=datetime.now(timezone.utc).isoformat(
                        timespec="milliseconds"
                    ),
                    provider="gemini",
                    model="models/gemini-embedding-2",
                    kind="embedding",
                    input_tokens=1000,
                    output_tokens=0,
                    cache_read_tokens=0,
                    cache_write_tokens=0,
                    reasoning_tokens=0,
                )
            )
        budgets = self.client.get("/api/v1/usage/budgets?view=organization").json()[
            "budgets"
        ]
        budget = budgets[0]
        self.assertEqual(budget["spent_usd"], 0.0002)
        self.assertEqual(budget["state"], "exceeded")
        payload["amount_usd"] = "1"
        self.assertEqual(
            self.client.put("/api/v1/usage/budgets", json=payload).status_code, 200
        )
        self.assertEqual(
            self.client.get("/api/v1/usage/budgets?view=organization").json()[
                "budgets"
            ][0]["state"],
            "warning",
        )
        self.assertEqual(
            self.client.delete(f"/api/v1/usage/budgets/{budget['id']}").status_code, 200
        )
        self.assertEqual(
            self.client.get("/api/v1/usage/budgets?view=organization").json()[
                "budgets"
            ],
            [],
        )

    def test_scoped_services_and_under_scoped_oauth_are_refused(self) -> None:
        self.user["token_type"] = "scoped"
        self.assertEqual(self.get().status_code, 403)
        self.user.pop("token_type")
        self.user.update(isOAuth=True, oauthScopes=["kb:read"])
        self.assertEqual(self.get().status_code, 403)
        self.user["oauthScopes"] = ["org:read"]
        self.assertEqual(self.get().status_code, 200)
        self.user = None
        self.assertEqual(self.get().status_code, 401)

    def test_validation_and_no_public_ingestion_route(self) -> None:
        self.user["role"] = "admin"
        self.assertEqual(self.get(interval="SQL injection").status_code, 422)
        self.assertEqual(self.get(offset=-1).status_code, 422)
        self.assertEqual(self.get(**{"from": "2026-11-01T00:00:00"}).status_code, 422)
        self.assertEqual(
            self.client.post("/api/v1/usage", json=event()).status_code, 405
        )
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/rates",
                json={
                    "provider": "test",
                    "model": "model",
                    "rates": {
                        "input": "NaN",
                        "output": 1,
                        "cache_read": 0,
                        "cache_write": 0,
                    },
                },
            ).status_code,
            422,
        )

    def test_budget_below_accounting_precision_is_rejected(self) -> None:
        self.user["role"] = "admin"
        self.assertEqual(
            self.client.put(
                "/api/v1/usage/budgets",
                json={
                    "scope": "organization",
                    "subject": "",
                    "amount_usd": "0.0000000001",
                },
            ).status_code,
            422,
        )

    def test_rate_reset_is_tenant_scoped_and_preserves_historical_costs(self) -> None:
        self.user["role"] = "admin"
        rate = {
            "provider": "test",
            "model": "model-a",
            "rates": {
                "input": "2",
                "output": "6",
                "cache_read": "0.2",
                "cache_write": "2.5",
            },
        }
        self.assertEqual(
            self.client.put("/api/v1/usage/rates", json=rate).status_code, 200
        )
        self.db.record(event(id="priced"))
        self.user["orgId"] = "org-b"
        self.client.request(
            "DELETE",
            "/api/v1/usage/rates",
            json={"provider": "test", "model": "model-a"},
        )
        self.assertEqual(len(self.db.rates("org-a")), 1)
        self.user["orgId"] = "org-a"
        self.assertEqual(
            self.client.request(
                "DELETE",
                "/api/v1/usage/rates",
                json={"provider": "test", "model": "model-a"},
            ).status_code,
            200,
        )
        self.assertEqual(self.db.rates("org-a"), [])
        priced = next(
            row for row in self.get().json()["events"] if row["id"] == "priced"
        )
        self.assertGreater(priced["cost_usd"], 0)


if __name__ == "__main__":
    unittest.main()
