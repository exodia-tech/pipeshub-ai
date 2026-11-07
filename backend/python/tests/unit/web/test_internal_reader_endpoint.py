import ipaddress
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.utils.model_egress import address_refusal
from app.web.deadline import Deadline
from app.web.endpoint import Endpoint


def test_managed_token_is_used_only_for_the_internal_reader(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRAWL4AI_INTERNAL_URL", "http://crawl4ai:11235")
    monkeypatch.setenv("CRAWL4AI_API_TOKEN", "managed-secret")
    assert Endpoint("http://crawl4ai:11235", "placeholder", source="crawl4ai", name="reader").headers() == {
        "Authorization": "Bearer managed-secret"
    }
    assert Endpoint("http://other:11235", "other-secret", source="crawl4ai", name="reader").headers() == {
        "Authorization": "Bearer other-secret"
    }
    assert Endpoint("http://crawl4ai:11235", "other-secret", source="firecrawl", name="reader").headers() == {
        "Authorization": "Bearer other-secret"
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source", "address", "allowed"),
    [
        ("crawl4ai", "http://crawl4ai:11235", True),
        ("crawl4ai", "http://crawl4ai:11236", False),
        ("crawl4ai", "http://other:11235", False),
        ("firecrawl", "http://crawl4ai:11235", False),
    ],
)
async def test_only_configured_internal_reader_gets_private_exception(
    monkeypatch: pytest.MonkeyPatch, source: str, address: str, allowed: bool
) -> None:
    monkeypatch.setenv("PIPESHUB_BLOCK_PRIVATE_ADDRESSES", "true")
    monkeypatch.setenv("CRAWL4AI_INTERNAL_URL", "http://crawl4ai:11235")
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=object())
    client.__aexit__ = AsyncMock(return_value=False)
    with (
        patch("app.web.endpoint.guarded_async_client", return_value=client) as factory,
        patch("app.web.endpoint.request_json", AsyncMock(return_value={})),
    ):
        await Endpoint(address, "", source=source, name="reader").call(
            "GET", "/health", Deadline.after(5)
        )
    assert factory.call_args.kwargs.get("allow_private_endpoint", False) is allowed


def test_internal_reader_exception_still_blocks_cloud_metadata() -> None:
    assert (
        address_refusal([ipaddress.ip_address("10.0.0.1")], allow_private=True) is None
    )
    assert (
        address_refusal([ipaddress.ip_address("169.254.169.254")], allow_private=True)
        is not None
    )


@pytest.mark.asyncio
async def test_real_http_respects_private_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = json.dumps({"version": "0.9.5"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("PIPESHUB_BLOCK_PRIVATE_ADDRESSES", "true")
    monkeypatch.setenv("CRAWL4AI_INTERNAL_URL", url)
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        monkeypatch.delenv(key, raising=False)
    try:
        assert await Endpoint(url, "", source="crawl4ai", name="reader").call(
            "GET", "/health", Deadline.after(5)
        ) == {"version": "0.9.5"}
        from app.web.errors import Unreachable

        with pytest.raises(Unreachable):
            await Endpoint(url, "", source="firecrawl", name="reader").call(
                "GET", "/health", Deadline.after(5)
            )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

