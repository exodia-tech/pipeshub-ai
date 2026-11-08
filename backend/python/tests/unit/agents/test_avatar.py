import unittest

from app.agents.avatar import parse_avatar_url


class PortraitValidationTest(unittest.TestCase):
    def test_owned_assets_only(self):
        self.assertIsNone(parse_avatar_url(None))
        self.assertEqual(parse_avatar_url('/assets/agents/elio-v1.png'), '/assets/agents/elio-v1.png')
        for value in ['https://example.com/a.png', '//example.com/a.png', '/assets/agents/../../a.png', '/assets/agents/a.svg', '/assets/agents/a.png?key=secret', 42]:
            with self.assertRaises(ValueError):
                parse_avatar_url(value)


if __name__ == '__main__':
    unittest.main()
