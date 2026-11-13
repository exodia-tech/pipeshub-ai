"""Model hooks persist counts and identity, never prompts, responses or credentials."""

from __future__ import annotations

import asyncio
import contextvars
import logging
import math
import os
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Iterator

    import httpx
    from langchain_core.callbacks import AsyncCallbackHandler
    from langchain_core.embeddings import Embeddings
    from langchain_core.messages import BaseMessage
    from langchain_core.outputs import LLMResult

    from app.services.embeddings.multimodal.interface import (
        IMultimodalEmbeddingProvider,
    )
    from app.services.model_identity.call_context import ModelCallContext

from app.services.usage.ledger import UsageLedger, timestamp

_Result = TypeVar("_Result")
logger = logging.getLogger(__name__)
_health_lock = threading.Lock()
_health = {"written": 0, "failed": 0, "missing_identity": 0}


def enabled() -> bool:
    return bool(os.getenv("PIPESHUB_USAGE_DB"))


def health() -> dict:
    with _health_lock:
        return {"enabled": enabled(), **_health, "scope": "this_process"}


@dataclass
class _Suppression:
    parent: _Suppression | None = None
    closed: bool = False


_suppression: contextvars.ContextVar[_Suppression | None] = contextvars.ContextVar(
    "usage_suppression", default=None
)


def suppressed() -> bool:
    frame = _suppression.get()
    while frame and frame.closed:
        frame = frame.parent
    return frame is not None


@contextmanager
def suppress_nested() -> Iterator[None]:
    frame = _Suppression(_suppression.get())
    _suppression.set(frame)
    try:
        yield
    finally:
        frame.closed = True
        if _suppression.get() is frame:
            _suppression.set(frame.parent)


def call_identity() -> tuple[ModelCallContext, str]:
    from app.services.model_identity.call_context import (
        current_call_context,
        current_llm_purpose,
    )

    return current_call_context(), current_llm_purpose()


def normalize_usage(
    raw: dict | None, *, normalized: bool = False, kind: str = "completion"
) -> tuple[dict, str]:
    raw = raw if isinstance(raw, dict) else {}

    def count(value: object) -> int:
        return value if type(value) is int and 0 <= value <= 100_000_000 else 0

    inp = count(
        raw.get("input_tokens", raw.get("prompt_tokens", raw.get("promptTokenCount")))
    )
    out = count(
        raw.get(
            "output_tokens",
            raw.get("completion_tokens", raw.get("candidatesTokenCount")),
        )
    )
    in_details = (
        raw.get("input_token_details") or raw.get("prompt_tokens_details") or {}
    )
    out_details = (
        raw.get("output_token_details") or raw.get("completion_tokens_details") or {}
    )
    in_details = in_details if isinstance(in_details, dict) else {}
    out_details = out_details if isinstance(out_details, dict) else {}
    read = count(
        raw.get(
            "cache_read_tokens",
            raw.get(
                "cache_read_input_tokens",
                in_details.get(
                    "cache_read",
                    in_details.get("cached_tokens", raw.get("cachedContentTokenCount")),
                ),
            ),
        )
    )
    write = count(
        raw.get(
            "cache_write_tokens",
            raw.get("cache_creation_input_tokens", in_details.get("cache_creation")),
        )
    )
    reasoning_value = raw.get(
        "reasoning_tokens",
        out_details.get(
            "reasoning",
            out_details.get("reasoning_tokens", raw.get("thoughtsTokenCount")),
        ),
    )
    reasoning = (
        count(reasoning_value)
        if reasoning_value is not None
        else 0
        if kind in ("embedding", "image_embedding")
        else None
    )

    if not normalized and "cache_read_input_tokens" in raw:
        inp += (
            read + write
        )  # Anthropic's raw input excludes the cache; LangChain's normalized input includes it.
    if not normalized and "thoughtsTokenCount" in raw:
        out += reasoning or 0
    inp, out = max(inp, read + write), max(out, reasoning or 0)
    input_values = [
        raw[k]
        for k in ("input_tokens", "prompt_tokens", "promptTokenCount")
        if k in raw
    ]
    output_values = [
        raw[k]
        for k in ("output_tokens", "completion_tokens", "candidatesTokenCount")
        if k in raw
    ]
    needed = (
        input_values
        if kind in ("embedding", "image_embedding")
        else input_values + output_values
    )
    known = (
        bool(input_values)
        and (bool(output_values) or kind in ("embedding", "image_embedding"))
        and all(type(v) is int and 0 <= v <= 100_000_000 for v in needed)
    )

    return {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_tokens": read,
        "cache_write_tokens": write,
        "reasoning_tokens": reasoning,
    }, "reported" if known else "unknown"


def emit(
    provider: str,
    model: str,
    raw: dict | None,
    started: float,
    *,
    identity: tuple[ModelCallContext, str] | None = None,
    kind: str = "completion",
    status: str = "success",
    normalized: bool = False,
    measurement: str | None = None,
    units: int = 1,
    event_id: str | None = None,
) -> None:
    if not enabled():
        return
    ctx, purpose = identity or call_identity()
    if not ctx.principal.org_id:
        with _health_lock:
            _health["missing_identity"] += 1
        return
    counts, detected = normalize_usage(raw, normalized=normalized, kind=kind)
    try:
        event = UsageLedger().record(
            {
                "id": event_id or str(uuid.uuid4()),
                "org_id": ctx.principal.org_id,
                "occurred_at": timestamp(),
                "provider": provider,
                "model": model,
                "user_id": ctx.principal.subject_id if ctx.principal.is_user else None,
                "user_label": ctx.principal.display_name
                if ctx.principal.is_user
                else None,
                "connector_id": ctx.connector_id,
                "agent_id": ctx.agent_id,
                "request_id": ctx.request_id,
                "workload": ctx.workload.value,
                "purpose": purpose,
                "kind": kind,
                "status": status,
                "duration_ms": max(0, round((time.monotonic() - started) * 1000)),
                "units": units,
                "measurement": measurement or detected,
                **counts,
            }
        )
        with _health_lock:
            _health["written"] += 1
    except Exception:
        # Provider work must survive an accounting outage; expose the gap instead of claiming complete coverage.
        with _health_lock:
            _health["failed"] += 1
        logger.error(
            "Usage ledger write failed; accounting coverage is incomplete",
            exc_info=True,
        )
        return
    if event:
        try:
            from app.services.usage.observability import export_usage

            export_usage(event)
        except Exception:
            logger.warning("Observability export unavailable; local usage is unaffected")


async def emit_async(
    provider: str,
    model: str,
    raw: dict | None,
    started: float,
    **metadata: Any,  # noqa: ANN401 - forwards event metadata
) -> None:
    if enabled():
        await asyncio.to_thread(emit, provider, model, raw, started, **metadata)


def chat_callback(provider: str, model: str) -> AsyncCallbackHandler:
    from langchain_core.callbacks import AsyncCallbackHandler

    class UsageCallback(AsyncCallbackHandler):
        run_inline = True

        def __init__(self) -> None:
            self.runs: dict = {}
            self.lock = threading.Lock()

        async def on_chat_model_start(
            self,
            serialized: dict,
            messages: list[list[BaseMessage]] | None,
            *,
            run_id: uuid.UUID,
            **kwargs: object,
        ) -> None:
            if enabled() and not suppressed():
                with self.lock:
                    self.runs[run_id] = (time.monotonic(), call_identity())

        async def on_llm_start(
            self,
            serialized: dict,
            prompts: list[str],
            *,
            run_id: uuid.UUID,
            **kwargs: object,
        ) -> None:
            await self.on_chat_model_start(serialized, None, run_id=run_id)

        async def on_llm_end(
            self, response: LLMResult, *, run_id: uuid.UUID, **kwargs: object
        ) -> None:
            with self.lock:
                started = self.runs.pop(run_id, None)
            if not started:
                return
            usage = (response.llm_output or {}).get("token_usage") or (
                response.llm_output or {}
            ).get("usage")
            actual_model = (response.llm_output or {}).get("model_name") or model
            normalized = False
            if response.generations and response.generations[0]:
                message = getattr(response.generations[0][0], "message", None)
                if getattr(message, "usage_metadata", None):
                    usage, normalized = message.usage_metadata, True
                metadata = getattr(message, "response_metadata", {}) or {}
                actual_model = (
                    metadata.get("model_name") or metadata.get("model") or actual_model
                )
                usage = usage or metadata.get("usage") or metadata.get("token_usage")
            await emit_async(
                provider,
                actual_model,
                usage,
                started[0],
                identity=started[1],
                normalized=normalized,
                event_id=str(run_id),
            )

        async def on_llm_error(
            self, error: BaseException, *, run_id: uuid.UUID, **kwargs: object
        ) -> None:
            with self.lock:
                started = self.runs.pop(run_id, None)
            if started:
                await emit_async(
                    provider,
                    model,
                    None,
                    started[0],
                    identity=started[1],
                    status="failed",
                    event_id=str(run_id),
                )

    return UsageCallback()


_embedding_usage: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "embedding_usage", default=None
)


def _install_embedding_usage(model: object) -> None:
    import httpx

    from app.services.model_identity.transport.client_paths import iter_client_slots

    def collect(response: httpx.Response) -> None:
        target = _embedding_usage.get()
        if target is None or response.status_code >= 400:
            return
        if "json" not in response.headers.get("content-type", ""):
            return
        try:
            body = response.json()
            usage = (
                body.get("usage")
                or body.get("usageMetadata")
                or (body.get("meta") or {}).get("billed_units")
            )
            if isinstance(usage, dict):
                if "total_tokens" in usage and not any(
                    key in usage
                    for key in ("input_tokens", "prompt_tokens", "promptTokenCount")
                ):
                    usage = {**usage, "input_tokens": usage["total_tokens"]}
                if normalize_usage(usage, kind="embedding")[1] == "reported":
                    target.append(usage)
        except (ValueError, AttributeError):
            return

    def sync_hook(response: httpx.Response) -> None:
        if _embedding_usage.get() is not None:
            response.read()
            collect(response)

    async def async_hook(response: httpx.Response) -> None:
        if _embedding_usage.get() is not None:
            await response.aread()
            await asyncio.to_thread(collect, response)

    for owner in (
        model,
        getattr(model, "_inner", None),
        getattr(model, "_query_inner", None),
    ):
        if owner is None:
            continue
        for slot in iter_client_slots(owner):
            client = slot.client
            if not getattr(client, "_exodia_usage_hook", False):
                # This hook has no connection settings: sharing it preserves SDK TLS, proxy and egress guards.
                client.event_hooks.setdefault("response", []).append(
                    async_hook if isinstance(client, httpx.AsyncClient) else sync_hook
                )
                client._exodia_usage_hook = True


def metered_embeddings(inner: Embeddings, provider: str, model: str) -> Embeddings:
    from langchain_core.embeddings import Embeddings

    if not enabled():
        return inner
    _install_embedding_usage(inner)

    class MeteredEmbeddings(Embeddings):
        def __getattr__(self, name: str) -> Any:  # noqa: ANN401 - forwards provider-specific SDK attributes unchanged
            return getattr(inner, name)

        def report(
            self,
            texts: list[str],
            readings: list[dict],
            started: float,
            identity: tuple[ModelCallContext, str],
            status: str = "success",
        ) -> None:
            if suppressed():
                return
            total, measurement = normalize_usage(None, kind="embedding")
            if readings:
                for reading in readings:
                    counts, _ = normalize_usage(reading, kind="embedding")
                    for key, value in counts.items():
                        total[key] += value
                measurement = "reported"
            elif status == "success":
                # shortcut: providers without usage responses use a character estimate, replace with provider counters when available.
                total["input_tokens"] = sum(
                    math.ceil(len(t) / 4) for t in texts if isinstance(t, str)
                )
                measurement = "estimated"
            emit(
                provider,
                model,
                total,
                started,
                identity=identity,
                kind="embedding",
                normalized=True,
                status=status,
                measurement=measurement,
                units=len(texts),
            )

        def measure_sync(
            self,
            operation: Callable[..., _Result],
            value: str | list[str],
            kwargs: dict[str, object],
        ) -> _Result:
            texts = [value] if isinstance(value, str) else value
            started, identity, readings, skip = (
                time.monotonic(),
                call_identity(),
                [],
                suppressed(),
            )
            token = _embedding_usage.set(readings)
            status = "failed"
            try:
                result = operation(value, **kwargs)
                status = "success"
                return result
            finally:
                try:
                    if not skip:
                        self.report(texts, readings, started, identity, status)
                finally:
                    _embedding_usage.reset(token)

        async def measure_async(
            self,
            operation: Callable[..., Awaitable[_Result]],
            value: str | list[str],
            kwargs: dict[str, object],
        ) -> _Result:
            texts = [value] if isinstance(value, str) else value
            started, identity, readings, skip = (
                time.monotonic(),
                call_identity(),
                [],
                suppressed(),
            )
            token = _embedding_usage.set(readings)
            status = "failed"
            try:
                result = await operation(value, **kwargs)
                status = "success"
                return result
            finally:
                try:
                    if not skip:
                        await asyncio.to_thread(
                            self.report, texts, readings, started, identity, status
                        )
                finally:
                    _embedding_usage.reset(token)

        def embed_documents(
            self, texts: list[str], **kwargs: object
        ) -> list[list[float]]:
            return self.measure_sync(inner.embed_documents, texts, kwargs)

        def embed_query(self, text: str, **kwargs: object) -> list[float]:
            return self.measure_sync(inner.embed_query, text, kwargs)

        async def aembed_documents(
            self, texts: list[str], **kwargs: object
        ) -> list[list[float]]:
            return await self.measure_async(inner.aembed_documents, texts, kwargs)

        async def aembed_query(self, text: str, **kwargs: object) -> list[float]:
            return await self.measure_async(inner.aembed_query, text, kwargs)

    return MeteredEmbeddings()


def metered_image_embeddings(
    inner: IMultimodalEmbeddingProvider, provider: str, model: str
) -> IMultimodalEmbeddingProvider:
    from app.services.embeddings.multimodal.interface import (
        IMultimodalEmbeddingProvider,
    )

    if not enabled():
        return inner
    _install_embedding_usage(inner)

    class MeteredImages(IMultimodalEmbeddingProvider):
        @property
        def provider_name(self) -> str:
            return inner.provider_name

        def supports_multimodal(self) -> bool:
            return inner.supports_multimodal()

        async def normalize(self, image_ref: str) -> str | None:
            return await inner.normalize(image_ref)

        async def embed_images(self, image_base64s: list[str]) -> list:
            started, identity, readings = time.monotonic(), call_identity(), []
            token = _embedding_usage.set(readings)
            status = "failed"
            try:
                with suppress_nested():
                    result = await inner.embed_images(image_base64s)
                status = (
                    "failed"
                    if any(getattr(item, "error", None) for item in result)
                    else "success"
                )
                return result
            finally:
                _embedding_usage.reset(token)
                counts, measurement = normalize_usage(None, kind="image_embedding")
                for reading in readings:
                    usage, measurement = normalize_usage(
                        reading, kind="image_embedding"
                    )
                    for key, value in usage.items():
                        counts[key] += value
                await emit_async(
                    provider,
                    model,
                    counts,
                    started,
                    identity=identity,
                    kind="image_embedding",
                    normalized=True,
                    measurement=measurement,
                    units=len(image_base64s),
                    status=status,
                )

    return MeteredImages()


_speech_usage: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "speech_usage", default=None
)


def collect_speech_usage(raw: dict | None) -> None:
    target = _speech_usage.get()
    if target is not None and isinstance(raw, dict):
        target.append(raw)


def metered_speech(adapter: Any, kind: str) -> Any:
    """Measure the adapter operation, including providers without an HTTP hook."""
    if not enabled():
        return adapter
    from functools import wraps

    method = "synthesize" if kind == "text_to_speech" else "transcribe"
    operation = getattr(adapter, method)

    @wraps(operation)
    async def measure(*args: Any, **kwargs: Any) -> Any:
        started, identity, readings = time.monotonic(), call_identity(), []
        token = _speech_usage.set(readings)
        status = "failed"
        try:
            with suppress_nested():
                result = await operation(*args, **kwargs)
            status = "success"
            return result
        finally:
            _speech_usage.reset(token)
            counts, measurement = normalize_usage(None, kind=kind)
            for reading in readings:
                usage, measurement = normalize_usage(reading, kind=kind)
                for key, value in usage.items():
                    if value is not None:
                        counts[key] = (counts[key] or 0) + value
            await emit_async(
                adapter.provider,
                adapter.model,
                counts,
                started,
                identity=identity,
                kind=kind,
                status=status,
                normalized=True,
                measurement=measurement,
            )

    setattr(adapter, method, measure)
    return adapter


def install_media_hook(client: object) -> None:
    """Count media/decision calls without buffering binary audio or streaming bodies."""
    if not enabled():
        return

    async def begin(request: httpx.Request) -> None:
        if any(
            part in request.url.path for part in ("/audio/", "/images/", "/decisions")
        ):
            request.extensions["exodia_usage_started"] = time.monotonic()
            request.extensions["exodia_usage_identity"] = call_identity()

    async def record(response: httpx.Response) -> None:
        path = response.request.url.path
        kind = (
            "speech"
            if "/audio/" in path
            else "image_generation"
            if "/images/" in path
            else "decision"
            if "/decisions" in path
            else None
        )
        speech_readings = _speech_usage.get()
        if kind is None or (suppressed() and speech_readings is None):
            return
        body, model = {}, "unknown"
        try:
            content = response.request.content
            if (
                "json" in response.request.headers.get("content-type", "")
                and len(content) < 65_536
            ):
                import json

                model = str(json.loads(content).get("model") or "unknown")
            if "application/json" in response.headers.get("content-type", ""):
                await response.aread()
                payload = response.json()
                body = payload if isinstance(payload, dict) else {}
        except Exception:
            pass
        if speech_readings is not None:
            if response.status_code < 400:
                collect_speech_usage(body.get("usage"))
            return
        host = response.request.url.host
        provider = (
            "openAI"
            if host == "api.openai.com"
            else "azureOpenAI"
            if "azure" in host
            else host
        )
        await emit_async(
            provider,
            str(body.get("model") or model),
            body.get("usage"),
            response.request.extensions.get("exodia_usage_started", time.monotonic()),
            kind=kind,
            identity=response.request.extensions.get("exodia_usage_identity"),
            status="success" if response.status_code < 400 else "failed",
        )

    client.event_hooks.setdefault("request", []).append(begin)
    client.event_hooks.setdefault("response", []).append(record)
