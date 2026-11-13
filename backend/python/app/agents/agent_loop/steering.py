"""Owner-checked, bounded follow-ups for a live run, shared between query workers."""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable

    from app.agent_loop_lib.agent import Agent
    from app.agent_loop_lib.core.types import Goal
    from app.agent_loop_lib.hooks.middleware.context import (
        ModelResponseContext,
        ToolCallContext,
        TurnContext,
    )
    from app.agent_loop_lib.hooks.middleware.pipeline import Next
    from app.agent_loop_lib.runtime.runtime import AgentRuntime
    from app.agents.agent_loop.cancellation.registry import RunOwner
    from app.config.key_value_store import KeyValueStore

TTL = 3600
MAX_UPDATES = 20


class SteeringInbox:
    def __init__(self, store: KeyValueStore[str]) -> None:
        self.store = store

    def key(self, run_id: str) -> str:
        return f"chat:steering:{run_id}"

    @asynccontextmanager
    async def locked(self, run_id: str) -> AsyncIterator[None]:
        key = self.key(run_id) + ":lock"
        token = str(uuid.uuid4())
        for _ in range(50):
            if await self.store.create_key(key, token, overwrite=False, ttl=30):
                break
            await asyncio.sleep(0.02)
        else:
            raise RuntimeError("Steering inbox is busy; retry the update")
        try:
            async with asyncio.timeout(8):
                yield
        finally:
            if await self.store.get_key(key) == token:
                await self.store.delete_key(key)

    async def read(self, run_id: str) -> dict | None:
        raw = await self.store.get_key(self.key(run_id), raise_on_error=True)
        return json.loads(raw) if raw else None

    async def write(self, run_id: str, state: dict) -> None:
        if not await self.store.create_key(
            self.key(run_id), json.dumps(state), ttl=TTL
        ):
            raise RuntimeError("Steering update could not be stored")

    async def register(self, run_id: str, owner: RunOwner, *, named_agent: bool = True) -> None:
        async with self.locked(run_id):
            if await self.read(run_id):
                raise ValueError("Run already registered for steering")
            await self.write(
                run_id,
                {"owner": owner.model_dump(), "namedAgent": named_agent, "open": True, "next": 0, "messages": []},
            )

    async def submit(
        self, run_id: str, owner: RunOwner, message_id: str, text: str,
        *, authorize: Callable[[bool], Awaitable[None]] | None = None,
    ) -> str:
        if (
            not text.strip()
            or len(text) > 8000
            or not message_id
            or len(message_id) > 100
        ):
            raise ValueError("Invalid steering message")
        async with self.locked(run_id):
            state = await self.read(run_id)
            if not state:
                return "finished"
            if not owner.conversation_id or state["owner"] != owner.model_dump():
                return "forbidden"
            # Pre-rollout runs have no action metadata; require named-agent permission.
            named_agent = state.get("namedAgent", True)
            if not isinstance(named_agent, bool):
                raise RuntimeError("Invalid steering action metadata")
            if authorize is not None:
                await authorize(named_agent)
            if any(m["id"] == message_id for m in state["messages"]):
                return "duplicate"
            if not state["open"]:
                return "finished"
            if len(state["messages"]) >= MAX_UPDATES:
                return "full"
            state["messages"].append({"id": message_id, "text": text})
            await self.write(run_id, state)
            return "queued"

    async def take(self, run_id: str) -> list[str]:
        async with self.locked(run_id):
            state = await self.read(run_id)
            if not state:
                return []
            messages = state["messages"][state["next"] :]
            state["next"] = len(state["messages"])
            state["open"] = True
            await self.write(run_id, state)
            return [m["text"] for m in messages]

    async def pending(self, run_id: str) -> bool:
        state = await self.read(run_id)
        return bool(state and state["next"] < len(state["messages"]))

    async def close_if_empty(self, run_id: str) -> bool:
        async with self.locked(run_id):
            state = await self.read(run_id)
            if not state:
                return True
            if state["next"] < len(state["messages"]):
                return False
            state["open"] = False
            await self.write(run_id, state)
            return True

    async def unregister(self, run_id: str) -> None:
        async with self.locked(run_id):
            state = await self.read(run_id)
            if state:
                state["open"] = False
                await self.write(run_id, state)
            await self.store.delete_key(self.key(run_id))


@lru_cache(maxsize=1)
def get_steering_inbox() -> SteeringInbox:
    from app.agents.agent_loop.cancellation.factory import _build_kv_store

    store = _build_kv_store()
    if store is None:
        raise RuntimeError("Live steering requires a configured shared key-value store")
    return SteeringInbox(store)


def install_steering(
    agent: Agent, runtime: AgentRuntime, goal: Goal, inbox: SteeringInbox, run_id: str,
    on_applied: Callable[[], Awaitable[None]] | None = None,
) -> None:
    """Use existing loop hooks; never replace a user update with an agent context note."""
    from app.agent_loop_lib.core.messages import UserMessage
    from app.agent_loop_lib.events.base import EventType
    from app.agent_loop_lib.hooks.events import HookEvent
    from app.agent_loop_lib.hooks.middleware.decisions import PreDecision
    from app.agent_loop_lib.tools.tags import TAG_LIFECYCLE_TERMINAL

    acknowledgment_guidance_added = False

    async def apply(
        messages: list[str], *, recovery: ModelResponseContext | None = None
    ) -> None:
        nonlocal acknowledgment_guidance_added
        if not messages:
            return
        if not acknowledgment_guidance_added:
            await agent.context.add(UserMessage(
                content=(
                    "Runtime guidance for Slack follow-ups: When you read a new requester update, "
                    "briefly acknowledge the specific change in your own words in your next user-facing "
                    "progress sentence before continuing tools. Do not use a stock confirmation or reveal "
                    "private reasoning. If you can answer immediately, incorporate the update directly "
                    "in your answer instead of adding an extra acknowledgment. Preserve the original "
                    "task except where the requester changes it; a courtesy alone does not cancel work."
                ),
                injected=True, pinned=True,
            ))
            acknowledgment_guidance_added = True
        for index, text in enumerate(messages):
            goal.user_message = text
            message = UserMessage(content=text, pinned=True)
            if recovery is not None and index == len(messages) - 1:
                recovery.recovery_message = message
            else:
                await agent.context.add(message)
        if on_applied is not None:
            await on_applied()

    async def before_turn(ctx: TurnContext, next_fn: Next) -> None:
        if ctx.scope is None or str(ctx.scope.run.identity.run_id) != str(run_id):
            await next_fn()
            return
        await apply(await inbox.take(run_id))
        await next_fn()

    async def after_model(ctx: ModelResponseContext, next_fn: Next) -> None:
        await next_fn()
        if ctx.scope is None or str(ctx.scope.run.identity.run_id) != str(run_id):
            return
        if ctx.tool_calls or ctx.recovery_message is not None or ctx.response.truncated:
            return
        if not await inbox.close_if_empty(run_id):
            await apply(await inbox.take(run_id), recovery=ctx)
            await agent.emit(
                EventType.TEXT_MESSAGE_END,
                {"turn_index": ctx.turn_index, "discarded": True},
            )

    async def before_tool(ctx: ToolCallContext, next_fn: Next) -> None:
        if ctx.scope is None or str(ctx.scope.turn.run.identity.run_id) != str(run_id):
            await next_fn()
            return
        terminal = TAG_LIFECYCLE_TERMINAL in ctx.tags or ctx.decision == PreDecision.ASK
        if await inbox.pending(run_id) or (
            terminal and not await inbox.close_if_empty(run_id)
        ):
            await agent.emit(
                EventType.TEXT_MESSAGE_END,
                {"turn_index": ctx.scope.turn.turn_index, "discarded": True},
            )
            ctx.deny(
                "The requester sent an update. Read it before continuing.",
                code="user_steering",
            )
            return
        await next_fn()

    runtime.hooks.on(HookEvent.PRE_TURN).use(before_turn)
    runtime.hooks.on(HookEvent.POST_MODEL).use(after_model)
    runtime.hooks.on(HookEvent.PRE_TOOL_USE).use(before_tool)
