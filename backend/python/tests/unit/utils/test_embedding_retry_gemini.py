"""
Regression tests: Gemini rate limits and outages must be retried like OpenAI's.

The Gemini embedder (langchain_google_genai.GoogleGenerativeAIEmbeddings)
raises GoogleGenerativeAIError, chained from the google-genai APIError that
carries the HTTP code. The shared retry policy has to see through that wrapper,
or a Gemini 429 fails search and indexing on the first attempt.
"""

import asyncio

import pytest
from aiohttp import web
from google.genai import errors as genai_errors
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_google_genai._common import GoogleGenerativeAIError

from app.utils import embedding_retry
from app.utils.embedding_retry import await_with_retry, is_retriable_embedding_error
from app.services.messaging.backpressure import BackpressureCoordinator


@pytest.mark.parametrize("wrapped", [False, True])
def test_gemini_throttle_pauses_queue_until_provider_retry_time(wrapped: bool) -> None:
    error = genai_errors.ClientError(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
        "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "60.5s"}]}})
    if wrapped:
        outer = GoogleGenerativeAIError("embedding failed")
        outer.__cause__ = error
        error = outer
    now = [0.0]
    coordinator = BackpressureCoordinator(clock=lambda: now[0])
    embedding_retry.signal_backpressure_if_rate_limited(error, service_name="gemini", coordinator=coordinator)
    assert coordinator.pause_remaining() == 60.5
    assert coordinator.is_paused()
    now[0] = 61
    assert not coordinator.is_paused()


def test_gemini_headerless_throttle_still_slows_queue() -> None:
    coordinator = BackpressureCoordinator(clock=lambda: 0)
    embedding_retry.signal_backpressure_if_rate_limited(_google_error(429, "RESOURCE_EXHAUSTED"), service_name="gemini", coordinator=coordinator)
    assert coordinator.pause_remaining() == 30


@pytest.mark.parametrize("delay", ["invalid", "NaNs", "infs", "-1s", "0s"])
def test_invalid_retry_info_cannot_disable_or_permanently_pause_queue(delay: str) -> None:
    error = genai_errors.ClientError(429, {"error": {"details": [
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay}]}})
    coordinator = BackpressureCoordinator(clock=lambda: 0)
    embedding_retry.signal_backpressure_if_rate_limited(error, service_name="gemini", coordinator=coordinator)
    assert coordinator.pause_remaining() == 30


def test_non_throttle_errors_do_not_pause_queue() -> None:
    coordinator = BackpressureCoordinator(clock=lambda: 0)
    embedding_retry.signal_backpressure_if_rate_limited(_google_error(403, "PERMISSION_DENIED"), service_name="gemini", coordinator=coordinator)
    assert not coordinator.is_paused()


def _google_error(code: int, status: str) -> genai_errors.APIError:
    body = {"error": {"code": code, "message": f"Simulated {status}.", "status": status}}
    cls = genai_errors.ClientError if code < 500 else genai_errors.ServerError
    return cls(code, body)


def _wrapped_like_langchain(code: int, status: str) -> GoogleGenerativeAIError:
    """Raise and catch the error the way langchain_google_genai does."""
    try:
        try:
            raise _google_error(code, status)
        except genai_errors.APIError as e:
            raise GoogleGenerativeAIError(f"Error embedding content ({status}): {e}") from e
    except GoogleGenerativeAIError as wrapped:
        return wrapped


class TestGeminiErrorClassification:
    @pytest.mark.parametrize(
        ("code", "status"),
        [(429, "RESOURCE_EXHAUSTED"), (502, "UNAVAILABLE"), (503, "UNAVAILABLE"), (504, "DEADLINE_EXCEEDED")],
    )
    def test_transient_google_errors_are_retriable(self, code: int, status: str) -> None:
        assert is_retriable_embedding_error(_wrapped_like_langchain(code, status))
        assert is_retriable_embedding_error(_google_error(code, status))

    @pytest.mark.parametrize(
        ("code", "status"),
        [(400, "INVALID_ARGUMENT"), (403, "PERMISSION_DENIED"), (404, "NOT_FOUND"), (500, "INTERNAL")],
    )
    def test_other_google_errors_are_not_retriable(self, code: int, status: str) -> None:
        assert not is_retriable_embedding_error(_wrapped_like_langchain(code, status))
        assert not is_retriable_embedding_error(_google_error(code, status))

    def test_wrapper_without_google_cause_is_not_retriable(self) -> None:
        assert not is_retriable_embedding_error(GoogleGenerativeAIError("Error embedding content: bad input"))


class _FakeGemini:
    """Answers every embed request with 429 a set number of times, then 200."""

    def __init__(self, failures: int) -> None:
        self.failures = failures
        self.requests = 0

    async def handle(self, request: web.Request) -> web.Response:
        self.requests += 1
        if self.requests <= self.failures:
            return web.json_response(
                {"error": {"code": 429, "message": "Resource exhausted. Please try again later.",
                           "status": "RESOURCE_EXHAUSTED"}},
                status=429,
            )
        return web.json_response({"embeddings": [{"values": [0.1, 0.2, 0.3]}]})


@pytest.fixture
def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(embedding_retry, "retry_delay_seconds", lambda attempt: 0.0)


async def _serve(fake: _FakeGemini) -> tuple[web.AppRunner, str]:
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", fake.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, f"http://127.0.0.1:{runner.addresses[0][1]}"


@pytest.mark.usefixtures("no_backoff")
async def test_query_embedding_recovers_from_a_gemini_429() -> None:
    """The search path: one throttled query embedding must not fail the search."""
    fake = _FakeGemini(failures=1)
    runner, base_url = await _serve(fake)
    coordinator = BackpressureCoordinator(clock=lambda: 0)
    try:
        embedder = GoogleGenerativeAIEmbeddings(
            model="models/gemini-embedding-2", google_api_key="test-key", base_url=base_url
        )
        vector = await asyncio.wait_for(
            await_with_retry(
                lambda: embedder.aembed_query("vpn error 809"),
                max_retries=3,
                operation="aembed_query",
                service_name="retrieval",
                backpressure_coordinator=coordinator,
            ),
            timeout=10,
        )
        assert vector == [0.1, 0.2, 0.3]
        assert fake.requests == 2
        assert coordinator.is_paused()
    finally:
        await runner.cleanup()


@pytest.mark.usefixtures("no_backoff")
async def test_persistent_gemini_429_still_fails_after_the_retry_budget() -> None:
    fake = _FakeGemini(failures=10)
    runner, base_url = await _serve(fake)
    try:
        embedder = GoogleGenerativeAIEmbeddings(
            model="models/gemini-embedding-2", google_api_key="test-key", base_url=base_url
        )
        with pytest.raises(GoogleGenerativeAIError):
            await asyncio.wait_for(
                await_with_retry(
                    lambda: embedder.aembed_query("vpn error 809"),
                    max_retries=3,
                    operation="aembed_query",
                    service_name="retrieval",
                ),
                timeout=10,
            )
        assert fake.requests == 3
    finally:
        await runner.cleanup()
