import unittest
from types import SimpleNamespace

from app.agents.agent_loop.read_only_registry import ReadOnlyRetrievalRegistry, matches_approved_model


class ReadOnlyRegistryTests(unittest.TestCase):
    def test_only_scoped_retrieval_and_terminal_answer_can_be_registered(self):
        registry = ReadOnlyRetrievalRegistry()
        retrieval = SimpleNamespace(name="search", path="/tools/retrieval/search_internal_knowledge")
        finish = SimpleNamespace(name="final_answer", path="/toolsets/builtin/final_answer")
        registry.register_tool(retrieval)
        registry.register_tool(finish)
        for name, path in [
            ("send_email", "/tools/gmail/send_email"),
            ("run_code", "/toolsets/sandbox/run_code"),
            ("fetch_url", "/tools/web/fetch_url"),
            ("search_tools", "/toolsets/builtin/search_tools"),
        ]:
            registry.register_tool(SimpleNamespace(name=name, path=path))
            self.assertFalse(registry.has(name))
        self.assertEqual(set(registry.names()), {"search", "final_answer"})

    def test_lazy_provider_cannot_introduce_an_unreviewed_tool(self):
        registry = ReadOnlyRetrievalRegistry()
        registry.register_toolset_provider(SimpleNamespace())
        self.assertFalse(registry.has("send_email"))

    def test_model_must_match_the_approved_configuration_and_exact_model(self):
        import hashlib
        import json

        config = {"configuration": {"model": "model-a, model-b", "temperature": 1}, "modelKey": "key", "provider": "provider"}
        fingerprint = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        # Matches JSON.stringify of this config in the Node grant service.
        self.assertEqual(fingerprint, "18c343c2b2f55158d0626d4625aedfc7b8b9ac4dd4d4b449db927e7389df268a")
        self.assertTrue(matches_approved_model(config, "key", "model-b", fingerprint))
        self.assertFalse(matches_approved_model(config, "key", "model-c", fingerprint))
        self.assertFalse(matches_approved_model({**config, "provider": "other"}, "key", "model-b", fingerprint))
        self.assertFalse(matches_approved_model(config, "wrong-key", "model-b", fingerprint))
        self.assertFalse(matches_approved_model(config, "key", "model-b", None))
        self.assertFalse(matches_approved_model({**config, "configuration": None}, "key", "model-b", fingerprint))


if __name__ == "__main__":
    unittest.main()
