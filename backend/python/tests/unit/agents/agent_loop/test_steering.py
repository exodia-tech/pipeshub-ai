import asyncio
import unittest

from app.agents.agent_loop.cancellation.registry import RunOwner
from app.agents.agent_loop.steering import SteeringInbox


class Store:
    def __init__(self) -> None:
        self.values = {}

    async def get_key(self, key, **kwargs) -> str | None:
        return self.values.get(key)

    async def create_key(self, key, value, overwrite=True, ttl=None) -> bool:
        if not overwrite and key in self.values:
            return False
        self.values[key] = value
        return True

    async def delete_key(self, key) -> bool:
        return self.values.pop(key, None) is not None


class TestSteeringInbox(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_run_requires_named_permission_before_enqueue(self) -> None:
        state = await self.worker.read("run-a")
        state.pop("namedAgent", None)
        await self.worker.write("run-a", state)
        checked = []

        async def refuse(named_agent: bool) -> None:
            checked.append(named_agent)
            raise PermissionError("Execution access was revoked")

        with self.assertRaises(PermissionError):
            await self.other_worker.submit("run-a", self.owner, "revoked", "New instructions", authorize=refuse)
        self.assertEqual(checked, [True])
        self.assertEqual((await self.worker.read("run-a"))["messages"], [])

    async def test_invalid_action_metadata_is_not_treated_as_universal_chat(self) -> None:
        state = await self.worker.read("run-a")
        state["namedAgent"] = "false"
        await self.worker.write("run-a", state)
        with self.assertRaises(RuntimeError):
            await self.worker.submit("run-a", self.owner, "invalid", "New instructions")
        self.assertEqual((await self.worker.read("run-a"))["messages"], [])

    async def asyncSetUp(self) -> None:
        self.store = Store()
        self.worker = SteeringInbox(self.store)
        self.other_worker = SteeringInbox(self.store)
        self.owner = RunOwner(user_id="alice", org_id="org-a", conversation_id="chat-a")
        await self.worker.register("run-a", self.owner)

    async def test_cross_worker_updates_are_ordered_and_deduplicated(self) -> None:
        self.assertEqual(
            await self.other_worker.submit(
                "run-a", self.owner, "msg-1", "Focus on the AI project"
            ),
            "queued",
        )
        self.assertEqual(
            await self.other_worker.submit(
                "run-a", self.owner, "msg-1", "Focus on the AI project"
            ),
            "duplicate",
        )
        self.assertEqual(await self.worker.take("run-a"), ["Focus on the AI project"])
        self.assertEqual(await self.worker.take("run-a"), [])

    async def test_other_user_tenant_or_conversation_cannot_steer(self) -> None:
        for patch in (
            {"user_id": "bob"},
            {"org_id": "org-b"},
            {"conversation_id": "chat-b"},
            {"conversation_id": None},
        ):
            stranger = self.owner.model_copy(update=patch)
            self.assertEqual(
                await self.other_worker.submit(
                    "run-a", stranger, "msg-x", "change task"
                ),
                "forbidden",
            )
        self.assertEqual(await self.worker.take("run-a"), [])

    async def test_completion_closes_admission_and_late_update_becomes_next_turn(
        self,
    ) -> None:
        self.assertTrue(await self.worker.close_if_empty("run-a"))
        self.assertEqual(
            await self.other_worker.submit("run-a", self.owner, "late", "new question"),
            "finished",
        )

    async def test_pending_update_prevents_completion_and_cleanup_removes_text(
        self,
    ) -> None:
        await self.other_worker.submit(
            "run-a", self.owner, "m", "private clarification"
        )
        self.assertFalse(await self.worker.close_if_empty("run-a"))
        self.assertEqual(await self.worker.take("run-a"), ["private clarification"])
        self.assertTrue(await self.worker.close_if_empty("run-a"))
        await self.worker.unregister("run-a")
        self.assertEqual(self.store.values, {})

    async def test_failed_storage_is_not_acknowledged_as_queued(self) -> None:
        original = self.store.create_key

        async def refuse_data(key, value, **kwargs) -> bool:
            return (
                await original(key, value, **kwargs) if key.endswith(":lock") else False
            )

        self.store.create_key = refuse_data
        with self.assertRaises(RuntimeError):
            await self.other_worker.submit("run-a", self.owner, "failed", "update")
        self.assertFalse(await self.worker.pending("run-a"))

    async def test_simultaneous_followups_are_not_lost(self) -> None:
        await asyncio.gather(
            *(
                self.other_worker.submit("run-a", self.owner, f"m{i}", f"update {i}")
                for i in range(5)
            )
        )
        self.assertEqual(
            set(await self.worker.take("run-a")), {f"update {i}" for i in range(5)}
        )


class TestSteeringHooks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        await TestSteeringInbox.asyncSetUp(self)
        from types import SimpleNamespace
        from unittest.mock import AsyncMock

        from app.agent_loop_lib.core.types import Goal
        from app.agent_loop_lib.hooks.registry import HookRegistry
        from app.agents.agent_loop.steering import install_steering

        self.hooks = HookRegistry()
        self.agent = SimpleNamespace(
            context=SimpleNamespace(add=AsyncMock()), emit=AsyncMock()
        )
        self.runtime = SimpleNamespace(hooks=self.hooks)
        self.goal = Goal(
            description="Review both projects", user_message="Review both projects"
        )
        self.scope = SimpleNamespace(
            run=SimpleNamespace(
                identity=SimpleNamespace(run_id="run-a"), session_id="session"
            ),
            turn_index=1,
        )
        self.applied = AsyncMock()
        install_steering(self.agent, self.runtime, self.goal, self.worker, "run-a", self.applied)

    async def test_followup_is_a_real_pinned_user_message_at_next_step(self) -> None:
        from app.agent_loop_lib.agent.hook_dispatch import dispatch_pre_turn

        await self.other_worker.submit("run-a", self.owner, "m", "Only the AI project")
        await dispatch_pre_turn(self.hooks, 1, scope=self.scope)
        message = self.agent.context.add.call_args.args[0]
        self.assertEqual(message.content, "Only the AI project")
        self.assertFalse(message.injected)
        self.assertTrue(message.pinned)
        self.assertEqual(self.goal.user_message, "Only the AI project")

    async def test_contextual_guidance_is_injected_once_without_replacing_user_identity(self) -> None:
        from app.agent_loop_lib.agent.hook_dispatch import dispatch_pre_turn

        for index, text in enumerate(("Make the shape softer", "Use green")):
            await self.other_worker.submit("run-a", self.owner, str(index), text)
            await dispatch_pre_turn(self.hooks, index, scope=self.scope)
            self.assertEqual(self.agent.context.add.call_args.args[0].content, text)
            self.assertFalse(self.agent.context.add.call_args.args[0].injected)
        notes = [call.args[0] for call in self.agent.context.add.call_args_list if call.args[0].injected]
        self.assertEqual(len(notes), 1)
        self.assertIn("specific change in your own words", notes[0].content)
        self.assertEqual(self.applied.await_count, 2)
        await dispatch_pre_turn(self.hooks, 3, scope=self.scope)
        self.assertEqual(self.applied.await_count, 2)

    async def test_child_cannot_consume_the_parent_update(self) -> None:
        from app.agent_loop_lib.agent.hook_dispatch import dispatch_pre_turn

        self.scope.run.identity.run_id = "child"
        await self.other_worker.submit("run-a", self.owner, "m", "Only AI")
        await dispatch_pre_turn(self.hooks, 1, scope=self.scope)
        self.agent.context.add.assert_not_called()
        self.applied.assert_not_awaited()
        self.assertTrue(await self.worker.pending("run-a"))

    async def test_update_arriving_during_thinking_forces_a_new_model_step(
        self,
    ) -> None:
        from app.agent_loop_lib.agent.hook_dispatch import dispatch_post_model
        from app.agent_loop_lib.core.messages import AssistantMessage

        await self.other_worker.submit("run-a", self.owner, "m", "Only AI")
        result = await dispatch_post_model(
            self.hooks,
            AssistantMessage(content="stale answer"),
            [],
            1,
            scope=self.scope,
        )
        self.assertEqual(result.recovery_message.content, "Only AI")
        self.assertFalse(result.recovery_message.injected)
        self.agent.emit.assert_awaited_once()

    async def test_pending_update_blocks_stale_tools_before_execution(self) -> None:
        from types import SimpleNamespace

        from app.agent_loop_lib.hooks.events import HookEvent
        from app.agent_loop_lib.hooks.middleware.context import ToolCallContext
        from app.agent_loop_lib.hooks.middleware.decisions import PreDecision

        await self.other_worker.submit("run-a", self.owner, "m", "Only AI")
        ctx = ToolCallContext(
            tool_path="send_message",
            tool_input={},
            scope=SimpleNamespace(turn=self.scope),
        )
        await self.hooks.on(HookEvent.PRE_TOOL_USE).dispatch(ctx)
        self.assertEqual(ctx.decision, PreDecision.DENY)
        self.assertTrue(await self.worker.pending("run-a"))

    async def test_terminal_question_closes_steering_before_parking(self) -> None:
        from types import SimpleNamespace

        from app.agent_loop_lib.hooks.events import HookEvent
        from app.agent_loop_lib.hooks.middleware.context import ToolCallContext
        from app.agent_loop_lib.tools.tags import TAG_LIFECYCLE_TERMINAL

        ctx = ToolCallContext(
            tool_path="ask_user_question",
            tool_input={},
            tags=(TAG_LIFECYCLE_TERMINAL,),
            scope=SimpleNamespace(turn=self.scope),
        )
        await self.hooks.on(HookEvent.PRE_TOOL_USE).dispatch(ctx)
        self.assertEqual(
            await self.other_worker.submit("run-a", self.owner, "late", "answer"),
            "finished",
        )
