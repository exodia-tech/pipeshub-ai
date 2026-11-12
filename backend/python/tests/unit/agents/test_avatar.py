import ast
from pathlib import Path
import unittest

from jsonschema import ValidationError, validate

from app.agents.avatar import parse_avatar_url


class PortraitValidationTest(unittest.TestCase):
    def test_owned_assets_only(self):
        self.assertIsNone(parse_avatar_url(None))
        self.assertEqual(parse_avatar_url('/assets/agents/elio-v1.png'), '/assets/agents/elio-v1.png')
        for value in ['https://example.com/a.png', '//example.com/a.png', '/assets/agents/../../a.png', '/assets/agents/a.svg', '/assets/agents/a.png?key=secret', 42]:
            with self.assertRaises(ValueError):
                parse_avatar_url(value)

    def test_graph_schema_accepts_portraits_on_creation_and_partial_updates(self):
        path = Path(__file__).resolve().parents[3] / 'app/schema/arango/documents.py'
        tree = ast.parse(path.read_text(encoding='utf-8'))
        schema = next(ast.literal_eval(node.value)['rule'] for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'agent_schema' for target in node.targets))
        agent = dict(name='Elio', description='AI scout', startMessage='Ciao', systemPrompt='Public research', models=[], createdBy='owner', createdAtTimestamp=1)
        for avatar in [None, '/assets/agents/elio-v1.png', '/api/v1/agents/e6ed44ce-65cc-42db-95bc-5db456f5f450/avatar/120d1a70-989a-499b-8e41-170b2a07a820']:
            validate({**agent, 'avatarUrl': avatar}, schema)
            partial = {**schema, 'required': []}
            validate({'avatarUrl': avatar}, partial)
        for avatar in ['https://example.com/a.png', '/assets/agents/../../a.png', 'data:image/png;base64,eA==']:
            with self.assertRaises(ValidationError):
                validate({'avatarUrl': avatar}, partial)

    def test_uploaded_picture_belongs_to_the_updated_agent(self):
        agent = 'e6ed44ce-65cc-42db-95bc-5db456f5f450'
        url = f'/api/v1/agents/{agent}/avatar/120d1a70-989a-499b-8e41-170b2a07a820'
        self.assertEqual(parse_avatar_url(url, agent), url)
        for wrong in [None, '120d1a70-989a-499b-8e41-170b2a07a820']:
            with self.assertRaises(ValueError):
                parse_avatar_url(url, wrong)


if __name__ == '__main__':
    unittest.main()
