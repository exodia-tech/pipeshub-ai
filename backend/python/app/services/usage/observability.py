"""Opt-in, content-free OTLP export of committed usage events."""

from __future__ import annotations

import atexit
import json
import logging
import os
import re
import threading
from datetime import datetime
from functools import lru_cache
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import httpx
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.trace import Status, StatusCode

if TYPE_CHECKING:
    from collections.abc import Sequence

logger = logging.getLogger(__name__)
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9_.:/-]{1,160}$")
_HEADER = re.compile(r"^[a-zA-Z0-9-]{1,80}$")


class _Exporter(SpanExporter):
    def __init__(self, endpoint: str, headers: dict[str, str]) -> None:
        self.endpoint = endpoint
        self.headers = {**headers, "Content-Type": "application/x-protobuf"}

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            response = httpx.post(
                self.endpoint,
                content=encode_spans(spans).SerializeToString(),
                headers=self.headers,
                timeout=3,
                follow_redirects=False,
            )
            if response.status_code == 200:
                from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
                    ExportTraceServiceResponse,
                )

                result = ExportTraceServiceResponse.FromString(response.content)
                if not result.partial_success.rejected_spans:
                    return SpanExportResult.SUCCESS
        except Exception:
            pass
        logger.warning("Observability export failed; usage remains in the local ledger")
        return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        pass


@lru_cache(maxsize=1)
def _provider() -> tuple[TracerProvider, str] | None:
    if os.getenv("EXODIA_OTLP_ENABLED", "false").lower() != "true":
        return None
    endpoint = os.getenv("EXODIA_OTLP_ENDPOINT", "")
    org = os.getenv("EXODIA_OTLP_ORG_ID", "")
    try:
        url = urlsplit(endpoint)
        if (
            (
                url.scheme != "https"
                and not (
                    url.scheme == "http"
                    and url.hostname in {"localhost", "127.0.0.1", "::1"}
                )
            )
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or not org
        ):
            raise ValueError("Invalid endpoint or organization")
        headers = json.loads(os.getenv("EXODIA_OTLP_HEADERS") or "{}")
        if not isinstance(headers, dict) or len(headers) > 20:
            raise ValueError("Invalid headers")
        for key, value in headers.items():
            if (
                not isinstance(key, str)
                or not _HEADER.fullmatch(key)
                or key.lower()
                in {
                    "host",
                    "content-length",
                    "content-type",
                    "transfer-encoding",
                    "proxy-authorization",
                }
                or not isinstance(value, str)
                or len(value) > 4096
                or any(ord(c) < 32 or ord(c) == 127 for c in value)
            ):
                raise ValueError("Invalid header")
        provider = TracerProvider(
            shutdown_on_exit=False, resource=Resource({"service.name": "exodia-brain"})
        )
        provider.add_span_processor(
            BatchSpanProcessor(
                _Exporter(endpoint, headers),
                max_queue_size=512,
                max_export_batch_size=64,
                schedule_delay_millis=1000,
            )
        )

        def shutdown() -> None:
            worker = threading.Thread(target=provider.shutdown, daemon=True)
            worker.start()
            worker.join(4)

        atexit.register(shutdown)
        return provider, org
    except (ValueError, TypeError):
        logger.error("Observability configuration is invalid; export disabled")
        return None


def export_usage(event: dict) -> None:
    try:
        configured = _provider()
        if not configured or event.get("org_id") != configured[1]:
            return
        provider, _ = configured
        kind = event.get("kind")
        embedding = kind in {"embedding", "image_embedding"}
        attrs = {
            "gen_ai.operation.name": "embeddings" if embedding else "chat",
            "langfuse.observation.type": "embedding" if embedding else "generation",
            "langfuse.observation.metadata.measurement": event["measurement"],
            "langfuse.observation.metadata.pricing_source": event["pricing_source"],
        }
        for key, target in (
            ("provider", "gen_ai.provider.name"),
            ("model", "gen_ai.request.model"),
        ):
            value = event.get(key)
            if (
                isinstance(value, str)
                and "://" not in value
                and _SAFE_NAME.fullmatch(value)
            ):
                attrs[target] = value
        if event["measurement"] != "unknown":
            attrs["gen_ai.usage.input_tokens"] = event["input_tokens"]
            attrs["gen_ai.usage.output_tokens"] = event["output_tokens"]
            if event["cache_read_tokens"]:
                attrs["gen_ai.usage.cache_read.input_tokens"] = event[
                    "cache_read_tokens"
                ]
            if event.get("reasoning_tokens") is not None:
                attrs["gen_ai.usage.reasoning.output_tokens"] = event[
                    "reasoning_tokens"
                ]
        if event["cost_nano_usd"] is not None:
            attrs["langfuse.observation.cost_details"] = json.dumps(
                {"total": event["cost_nano_usd"] / 1_000_000_000}
            )
        end = int(
            datetime.fromisoformat(
                event["occurred_at"].replace("Z", "+00:00")
            ).timestamp()
            * 1_000_000_000
        )
        span = provider.get_tracer("exodia.usage").start_span(
            "model usage",
            attributes=attrs,
            start_time=max(0, end - event["duration_ms"] * 1_000_000),
        )
        if event["status"] != "success":
            span.set_status(Status(StatusCode.ERROR))
        span.end(end_time=end)
    except Exception:
        logger.warning(
            "Observability export could not be queued; local usage is unaffected"
        )
