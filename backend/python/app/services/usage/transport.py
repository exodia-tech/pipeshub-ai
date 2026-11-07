"""Meter every agent transport, independently of the optional UI run-usage frame."""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from app.agent_loop_lib.core.responses import ModelResponse, StructuredResponse
    from app.agent_loop_lib.core.streaming import StreamEvent
    from app.services.model_identity.call_context import ModelCallContext

from app.agent_loop_lib.core.streaming import StreamCompleteEvent
from app.agent_loop_lib.transport.base import LLMTransport
from app.services.usage.meter import call_identity, emit, suppress_nested


class MeteredTransport(LLMTransport):
    def __init__(self, inner: LLMTransport) -> None:
        self.inner = inner

    @property
    def provider(self) -> str:
        return self.inner.provider

    @property
    def model_name(self) -> str:
        return self.inner.model_name

    def report(
        self,
        response: ModelResponse | StructuredResponse | None,
        started: float,
        identity: tuple[ModelCallContext, str],
        status: str = "success",
        requested_model: str | None = None,
    ) -> None:
        usage = (
            response.usage.model_dump()
            if response is not None and response.usage is not None
            else None
        )
        model = getattr(response, "model", None) or requested_model or self.model_name
        emit(
            self.provider,
            model,
            usage,
            started,
            identity=identity,
            normalized=True,
            # Transports default absent counters to zero; zero-sided calls cannot be priced confidently.
            measurement="reported"
            if usage and usage["input_tokens"] > 0 and usage["output_tokens"] > 0
            else "unknown",
            status=status,
        )

    async def complete(self, *args: Any, **kwargs: Any) -> ModelResponse:  # noqa: ANN401 - forwards the transport interface unchanged
        started, identity = time.monotonic(), call_identity()
        try:
            with suppress_nested():
                response = await self.inner.complete(*args, **kwargs)
        except BaseException:
            await asyncio.to_thread(
                self.report, None, started, identity, "failed", kwargs.get("model")
            )
            raise
        await asyncio.to_thread(
            self.report,
            response,
            started,
            identity,
            requested_model=kwargs.get("model"),
        )
        return response

    async def complete_structured(
        self,
        *args: Any,  # noqa: ANN401 - forwards positional transport arguments unchanged
        **kwargs: Any,  # noqa: ANN401 - forwards the transport interface unchanged
    ) -> StructuredResponse:
        started, identity = time.monotonic(), call_identity()
        try:
            with suppress_nested():
                response = await self.inner.complete_structured(*args, **kwargs)
        except BaseException:
            await asyncio.to_thread(
                self.report, None, started, identity, "failed", kwargs.get("model")
            )
            raise
        await asyncio.to_thread(
            self.report,
            response,
            started,
            identity,
            requested_model=kwargs.get("model"),
        )
        return response

    async def stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[StreamEvent]:  # noqa: ANN401 - forwards the transport interface unchanged
        started, identity, response = time.monotonic(), call_identity(), None
        status = "cancelled"
        try:
            with suppress_nested():
                async for event in self.inner.stream(*args, **kwargs):
                    if isinstance(event, StreamCompleteEvent):
                        response, status = event.response, "success"
                    yield event
        except (GeneratorExit, asyncio.CancelledError):
            raise
        except BaseException:
            status = "failed"
            raise
        finally:
            await asyncio.to_thread(
                self.report, response, started, identity, status, kwargs.get("model")
            )
