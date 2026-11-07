import asyncio
import tempfile
import time
import unittest
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from langchain_core.embeddings import Embeddings
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from app.agent_loop_lib.core.messages import AssistantMessage
from app.agent_loop_lib.core.responses import ModelResponse, TokenUsage
from app.agent_loop_lib.transport.base import LLMTransport
from app.services.model_identity.call_context import ModelCallContext, bind_call_context
from app.services.model_identity.principal import service_principal, user_principal
from app.services.model_identity.workload import Workload
from app.services.usage.ledger import UsageLedger
from app.services.usage.meter import (
    chat_callback,
    emit,
    install_media_hook,
    metered_embeddings,
    normalize_usage,
    suppressed,
)
from app.services.usage.transport import MeteredTransport


def context(
    user: str | None = "alice",
    org: str = "org-a",
    workload: Workload = Workload.CHAT,
    connector: str | None = None,
) -> ModelCallContext:
    principal = (
        user_principal({"userId": user, "orgId": org, "fullName": user})
        if user
        else service_principal("indexing", org)
    )
    return ModelCallContext(
        principal=principal, workload=workload, connector_id=connector
    )


class TestUsageMeter(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = UsageLedger(str(Path(self.temp.name) / "usage.db"))
        env = patch.dict("os.environ", {"PIPESHUB_USAGE_DB": self.db.path})
        env.start()
        self.addCleanup(env.stop)
        catalog = patch("app.services.usage.ledger.catalog_rates", return_value=None)
        catalog.start()
        self.addCleanup(catalog.stop)

    def events(self, org: str = "org-a") -> list[dict]:
        return self.db.report(
            org,
            "2020-01-01T00:00:00+00:00",
            "2030-01-01T00:00:00+00:00",
            {},
            interval="month",
        )["events"]

    def test_provider_cache_normalization(self) -> None:
        usage, measurement = normalize_usage(
            {
                "input_tokens": 10,
                "output_tokens": 3,
                "cache_read_input_tokens": 5,
                "cache_creation_input_tokens": 2,
            }
        )
        self.assertEqual(
            (usage["input_tokens"], usage["cache_read_tokens"], measurement),
            (17, 5, "reported"),
        )
        usage, _ = normalize_usage(
            {
                "input_tokens": 17,
                "output_tokens": 3,
                "input_token_details": {"cache_read": 5, "cache_creation": 2},
            },
            normalized=True,
        )
        self.assertEqual(usage["input_tokens"], 17)
        self.assertEqual(normalize_usage(None)[1], "unknown")

    def test_partial_completion_is_unknown_but_embedding_input_is_complete(
        self,
    ) -> None:
        usage, measurement = normalize_usage({"input_tokens": 10})
        self.assertEqual(measurement, "unknown")
        self.assertIsNone(usage["reasoning_tokens"])
        self.assertEqual(
            normalize_usage({"input_tokens": 10}, kind="embedding")[1], "reported"
        )

    async def test_shared_chat_callback_keeps_parallel_tenants_separate(self) -> None:
        model = GenericFakeChatModel(
            messages=iter(
                [
                    AIMessage(
                        content="private answer",
                        usage_metadata={
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "total_tokens": 15,
                        },
                    )
                    for _ in range(2)
                ]
            ),
            callbacks=[chat_callback("test", "model-a")],
        )

        async def call(org: str, user: str) -> AIMessage:
            with bind_call_context(context(user, org)):
                return await model.ainvoke("private prompt")

        await asyncio.gather(call("org-a", "alice"), call("org-b", "bob"))
        self.assertEqual(self.events()[0]["user_id"], "alice")
        self.assertEqual(self.events("org-b")[0]["user_id"], "bob")
        with self.db.connection() as db:
            persisted = str(
                [tuple(r) for r in db.execute("SELECT * FROM usage_events")]
            )
        self.assertNotIn("private prompt", persisted)
        self.assertNotIn("private answer", persisted)

    async def test_embedding_reports_real_provider_tokens_and_preserves_client(
        self,
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"usage": {"prompt_tokens": 123, "total_tokens": 123}, "data": []},
            )

        client = httpx.Client(transport=httpx.MockTransport(handler))
        async_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addCleanup(client.close)
        self.addAsyncCleanup(async_client.aclose)

        class FakeEmbeddings(Embeddings):
            root_client = SimpleNamespace(_client=client)
            root_async_client = SimpleNamespace(_client=async_client)

            def embed_documents(
                self, texts: list[str], **kwargs: object
            ) -> list[list[float]]:
                client.post("https://test/embeddings", json={"input": texts})
                return [[1.0] for _ in texts]

            def embed_query(self, text: str, **kwargs: object) -> list[float]:
                return self.embed_documents([text])[0]

            async def aembed_documents(
                self, texts: list[str], **kwargs: object
            ) -> list[list[float]]:
                await async_client.post(
                    "https://test/embeddings", json={"input": texts}
                )
                return [[1.0] for _ in texts]

            async def aembed_query(self, text: str, **kwargs: object) -> list[float]:
                return (await self.aembed_documents([text]))[0]

        inner = FakeEmbeddings()
        model = metered_embeddings(inner, "test", "embed-a")
        self.assertIs(model.root_client._client, client)
        with bind_call_context(
            context(None, workload=Workload.INDEXING, connector="drive-1")
        ):
            await model.aembed_documents(["sensitive document"])
        row = self.events()[0]
        self.assertEqual(
            (
                row["input_tokens"],
                row["measurement"],
                row["connector_id"],
                row["user_id"],
            ),
            (123, "reported", "drive-1", None),
        )

    async def test_agent_transport_does_not_double_count_nested_chat_callbacks(
        self,
    ) -> None:
        model = GenericFakeChatModel(
            messages=iter(
                [
                    AIMessage(
                        content="answer",
                        usage_metadata={
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "total_tokens": 15,
                        },
                    )
                ]
            ),
            callbacks=[chat_callback("test", "model-a")],
        )

        class FakeTransport(LLMTransport):
            provider = "test"
            model_name = "model-a"

            async def complete(self, *args: object, **kwargs: object) -> ModelResponse:
                await model.ainvoke("private")
                return ModelResponse(
                    message=AssistantMessage(content=[]),
                    usage=TokenUsage(input_tokens=10, output_tokens=5),
                )

            async def complete_structured(
                self, *args: object, **kwargs: object
            ) -> ModelResponse:
                return await self.complete()

            async def stream(
                self, *args: object, **kwargs: object
            ) -> AsyncIterator[str]:
                yield "partial"

        with bind_call_context(context()):
            await MeteredTransport(FakeTransport()).complete([])
        self.assertEqual(len(self.events()), 1)
        with bind_call_context(context()):
            stream = MeteredTransport(FakeTransport()).stream([])
            await anext(stream)
            await stream.aclose()
        self.assertFalse(suppressed())
        self.assertEqual(self.events()[0]["status"], "cancelled")

    def test_accounting_failure_never_fails_the_model_operation(self) -> None:
        with (
            bind_call_context(context()),
            patch.object(
                UsageLedger, "record", side_effect=OSError("disk unavailable")
            ),
        ):
            emit("test", "model-a", {}, time.monotonic())

    async def test_media_uses_counts_without_persisting_audio_or_image_content(
        self,
    ) -> None:
        responses = [
            httpx.Response(
                200, content=b"private audio", headers={"Content-Type": "audio/mpeg"}
            ),
            httpx.Response(
                200,
                json={
                    "data": [{"b64_json": "private-image"}],
                    "usage": {"input_tokens": 12, "output_tokens": 6},
                },
            ),
        ]
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: responses.pop(0))
        ) as client:
            install_media_hook(client)
            with bind_call_context(context()):
                await client.post(
                    "https://api.openai.com/v1/audio/speech",
                    json={"model": "tts-a", "input": "private speech"},
                )
                await client.post(
                    "https://api.openai.com/v1/images/generations",
                    json={"model": "image-a", "prompt": "private image prompt"},
                )
        rows = {row["kind"]: row for row in self.events()}
        self.assertEqual(rows["speech"]["measurement"], "unknown")
        self.assertIsNone(rows["speech"]["cost_usd"])
        self.assertEqual(rows["image_generation"]["input_tokens"], 12)
        with self.db.connection() as db:
            self.assertNotIn(
                "private",
                str([tuple(row) for row in db.execute("SELECT * FROM usage_events")]),
            )

    async def test_missing_embedding_counters_are_estimated_instead_of_reported_zero(
        self,
    ) -> None:
        class LocalEmbeddings(Embeddings):
            def embed_documents(
                self, texts: list[str], **kwargs: object
            ) -> list[list[float]]:
                return [[1.0] for _ in texts]

            def embed_query(self, text: str, **kwargs: object) -> list[float]:
                return [1.0]

        with bind_call_context(context()):
            metered_embeddings(LocalEmbeddings(), "local", "custom").embed_documents(
                ["eightchr"]
            )
        self.assertEqual(
            (self.events()[0]["measurement"], self.events()[0]["input_tokens"]),
            ("estimated", 2),
        )


if __name__ == "__main__":
    unittest.main()
