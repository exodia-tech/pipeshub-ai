import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from test_ledger import event

from app.services.usage import observability


@patch("app.services.usage.ledger.UsageLedger.observability_enabled", return_value=True)
def test_org_filter_and_metadata_only(_enabled) -> None:
    memory = InMemorySpanExporter()
    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(SimpleSpanProcessor(memory))
    row = {
        **event(user_label="private@example.com"),
        "pricing_source": "custom",
        "cost_nano_usd": 1000,
    }
    with patch.object(observability, "_provider", return_value=(provider, "org-a")):
        observability.export_usage({**row, "org_id": "another-org"})
        observability.export_usage(row)
    spans = memory.get_finished_spans()
    assert len(spans) == 1
    attrs = dict(spans[0].attributes)
    assert attrs["gen_ai.usage.input_tokens"] == 100
    assert json.loads(attrs["langfuse.observation.cost_details"])["total"] == 0.000001
    assert "private@example.com" not in repr(attrs)
    assert "user-a" not in repr(attrs)
    provider.shutdown()


@patch("app.services.usage.ledger.UsageLedger.observability_enabled", return_value=True)
def test_unknown_usage_and_unpriced_are_not_zeroes(_enabled) -> None:
    memory = InMemorySpanExporter()
    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(SimpleSpanProcessor(memory))
    with patch.object(observability, "_provider", return_value=(provider, "org-a")):
        observability.export_usage(
            {
                **event(),
                "measurement": "unknown",
                "pricing_source": "unpriced",
                "cost_nano_usd": None,
            }
        )
    attrs = memory.get_finished_spans()[0].attributes
    assert "gen_ai.usage.input_tokens" not in attrs
    assert "langfuse.observation.cost_details" not in attrs
    provider.shutdown()


def test_invalid_endpoint_and_secret_headers_are_rejected(monkeypatch, caplog) -> None:
    monkeypatch.setenv("EXODIA_OTLP_ENABLED", "true")
    monkeypatch.setenv("EXODIA_OTLP_ORG_ID", "org-a")
    monkeypatch.setenv("EXODIA_OTLP_ENDPOINT", "https://secret@example.com/v1/traces")
    monkeypatch.setenv("EXODIA_OTLP_HEADERS", '{"Authorization":"private-secret"}')
    observability._provider.cache_clear()
    assert observability._provider() is None
    assert "private-secret" not in caplog.text
    assert "secret@example.com" not in caplog.text
    observability._provider.cache_clear()


def test_export_is_disabled_by_default(monkeypatch) -> None:
    monkeypatch.delenv("EXODIA_OTLP_ENABLED", raising=False)
    observability._provider.cache_clear()
    assert observability._provider() is None
    observability._provider.cache_clear()


def test_collector_failure_does_not_raise() -> None:
    exporter = observability._Exporter(
        "https://collector.invalid/v1/traces", {}, "org-a"
    )
    with (
        patch(
            "app.services.usage.ledger.UsageLedger.observability_enabled",
            return_value=True,
        ),
        patch(
            "app.services.usage.observability.httpx.post", side_effect=OSError("secret")
        ),
    ):
        assert exporter.export(()) == observability.SpanExportResult.FAILURE


def test_disabling_stops_queued_export() -> None:
    exporter = observability._Exporter(
        "https://collector.invalid/v1/traces", {}, "org-a"
    )
    with (
        patch(
            "app.services.usage.ledger.UsageLedger.observability_enabled",
            return_value=False,
        ),
        patch("app.services.usage.observability.httpx.post") as send,
    ):
        assert exporter.export(()) == observability.SpanExportResult.FAILURE
        send.assert_not_called()


@patch("app.services.usage.ledger.UsageLedger.observability_enabled", return_value=True)
def test_otlp_http_export_to_local_collector(_enabled, monkeypatch) -> None:
    received = []

    class Collector(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            received.append(
                (
                    self.headers.get("Authorization"),
                    self.rfile.read(int(self.headers["Content-Length"])),
                )
            )
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Collector)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("EXODIA_OTLP_ENABLED", "true")
    monkeypatch.setenv("EXODIA_OTLP_ORG_ID", "org-a")
    monkeypatch.setenv(
        "EXODIA_OTLP_ENDPOINT", f"http://127.0.0.1:{server.server_port}/v1/traces"
    )
    monkeypatch.setenv("EXODIA_OTLP_HEADERS", '{"Authorization":"Basic dummy-secret"}')
    observability._provider.cache_clear()
    try:
        observability.export_usage(
            {
                **event(user_label="private@example.com"),
                "pricing_source": "unpriced",
                "cost_nano_usd": None,
            }
        )
        provider, _ = observability._provider()
        assert provider.force_flush(timeout_millis=5000)
        assert len(received) == 1
        header, payload = received[0]
        assert header == "Basic dummy-secret"
        parsed = ExportTraceServiceRequest.FromString(payload)
        assert len(parsed.resource_spans[0].scope_spans[0].spans) == 1
        assert b"private@example.com" not in payload
        assert b"dummy-secret" not in payload
        provider.shutdown()
    finally:
        observability._provider.cache_clear()
        server.shutdown()
        server.server_close()
