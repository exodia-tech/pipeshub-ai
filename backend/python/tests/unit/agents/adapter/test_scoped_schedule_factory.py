"""The real factory must not expose built-in write or network tools to scheduled drafts."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_loop_lib.tools.decorators import tool
from app.agents.agent_loop.factory import PipesHubAgentFactory
from tests.unit.agents.adapter.conftest import FakeChatModel, make_context


class RetrievalToolset:
    def __init__(self, state=None):
        self.state = state

    @tool(path="/tools/retrieval/search_internal_knowledge", short_description="Search", description="Read scoped sources")
    async def search_internal_knowledge(self, query: str) -> str:
        return "synthetic result"


class UnsafeToolset:
    def __init__(self, state=None):
        self.state = state

    @tool(path="/tools/unsafe/send_email", short_description="Send", description="Send an email")
    async def send_email(self, query: str) -> str:
        raise AssertionError("The unsafe tool must never be exposed")


@pytest.mark.asyncio
async def test_factory_grants_only_retrieval_and_answer_for_scoped_schedule(monkeypatch):
    monkeypatch.setenv("SANDBOX_MODE", "local")
    monkeypatch.setenv("SANDBOX_ALLOW_LOCAL", "true")
    context = make_context(llm=FakeChatModel(), has_knowledge=True)
    context.tool_state["safe_retrieval_only"] = True
    toolsets = MagicMock()
    toolsets.get_all_toolsets.return_value = {
        "retrieval": {"class": RetrievalToolset, "isInternal": True, "essential": True},
        "unsafe": {"class": UnsafeToolset, "isInternal": True},
    }
    with patch("app.agents.registry.toolset_registry.get_toolset_registry", return_value=toolsets), \
         patch("app.agents.agent_loop.tool_loader.ClientFactoryRegistry.get_factory", return_value=None), \
         patch("app.agents.agent_loop.factory.build_coding_sandbox_manager", new_callable=AsyncMock) as sandbox, \
         patch("app.agents.agent_loop.factory.skills_enabled", return_value=True), \
         patch("app.agents.agent_loop.factory._composed_agents_enabled", return_value=True):
        agent, runtime, _, _ = await PipesHubAgentFactory().create(context, context.llm, "quick", query="summarize")
    assert not sandbox.called
    assert runtime.tool_registry.has("retrieval__search_internal_knowledge")
    assert not runtime.tool_registry.has("unsafe__send_email")
    assert not runtime.tool_registry.has("run_code")
    assert not runtime.tool_registry.has("search_tools")
    assert set(agent.spec.tool_names) <= {"retrieval__search_internal_knowledge", "final_answer"}
    assert "retrieval__search_internal_knowledge" in agent.spec.tool_names
