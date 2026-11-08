import contextlib
import io
import json
import pathlib
import unittest
import urllib.error
from unittest.mock import MagicMock, patch


SCRIPT = pathlib.Path(__file__).with_name('exodia-admin-bootstrap.py').read_text()


class Response:
    def __init__(self, body, headers=None):
        self.data = io.BytesIO(json.dumps(body).encode())
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, *args):
        return self.data.read(*args)


class BootstrapTest(unittest.TestCase):
    def simulate(self, exists, auth_ok=False, created_org_becomes_visible=False):
        requests = []
        marker = MagicMock()

        def urlopen(request, timeout):
            nonlocal exists
            path = request.full_url.removeprefix('http://127.0.0.1:3000')
            requests.append(path)
            if path == '/api/v1/org/exists':
                return Response({'exists': exists})
            if path == '/api/v1/org':
                if created_org_becomes_visible:
                    exists = True
                return Response({})
            if path.endswith('/initAuth'):
                return Response({}, {'x-session-token': 'test-session'})
            if path.endswith('/authenticate') and auth_ok:
                return Response({'accessToken': 'test-access'})
            raise urllib.error.HTTPError(request.full_url, 400, 'Rejected old installation credentials', {}, None)

        with patch('urllib.request.urlopen', urlopen), patch('time.sleep'), patch('pathlib.Path', return_value=marker), patch.dict('os.environ', {'EXODIA_ADMIN_EMAIL': 'admin@example.invalid', 'EXODIA_ADMIN_PASSWORD': 'test-only-installation-password'}), contextlib.redirect_stdout(io.StringIO()):
            exec(compile(SCRIPT, 'exodia-admin-bootstrap.py', 'exec'), {})
        return marker, requests

    def test_existing_organization_does_not_depend_on_installation_password(self):
        marker, requests = self.simulate(True)
        marker.touch.assert_called_once()
        self.assertEqual(requests, ['/api/v1/org/exists'])

    def test_new_organization_still_requires_successful_admin_authentication(self):
        marker, requests = self.simulate(False, auth_ok=True)
        marker.touch.assert_called_once()
        self.assertIn('/api/v1/org', requests)
        self.assertIn('/api/v1/userAccount/authenticate', requests)

    def test_failed_initial_authentication_does_not_mark_ready(self):
        marker, requests = self.simulate(False, created_org_becomes_visible=True)
        marker.touch.assert_not_called()
        self.assertEqual(requests.count('/api/v1/org'), 1)


if __name__ == '__main__':
    unittest.main()
