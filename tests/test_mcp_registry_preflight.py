import io
import json
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError

from scripts.mcp_registry_preflight import MAX_RESPONSE_BYTES, NoRedirect, publication_needed


class RegistryPreflightTests(unittest.TestCase):
    manifest = {"name": "io.github.402signalhq/402signal", "version": "0.3.1", "remotes": []}

    def opener(self, payload, status=200):
        response = io.BytesIO(payload)
        response.status = status
        return Mock(open=Mock(return_value=response))

    def entry(self, manifest=None, status="active"):
        return json.dumps({"server": manifest or self.manifest, "_meta": {
            "io.modelcontextprotocol.registry/official": {"status": status}}}).encode()

    def test_identical_active_version_is_skipped(self):
        opener = self.opener(self.entry())
        self.assertFalse(publication_needed(self.manifest, opener))
        request = opener.open.call_args.args[0]
        self.assertIn("io.github.402signalhq%2F402signal/versions/0.3.1", request.full_url)
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 30})

    def test_only_404_allows_publication(self):
        opener = Mock(open=Mock(side_effect=HTTPError("url", 404, "missing", {}, None)))
        self.assertTrue(publication_needed(self.manifest, opener))
        for code in (401, 403, 429, 500, 503):
            with self.subTest(code=code), self.assertRaises(HTTPError):
                publication_needed(self.manifest, Mock(open=Mock(side_effect=HTTPError("url", code, "error", {}, None))))

    def test_conflicting_metadata_fails(self):
        with self.assertRaisesRegex(ValueError, "immutable version differs"):
            publication_needed(self.manifest, self.opener(self.entry({**self.manifest, "description": "changed"})))

    def test_inactive_or_missing_status_fails(self):
        for status in ("deleted", "deprecated", None):
            with self.subTest(status=status), self.assertRaises(ValueError):
                publication_needed(self.manifest, self.opener(self.entry(status=status)))

    def test_invalid_and_oversized_responses_fail(self):
        for payload in (b"not json", b"{}", b" " * (MAX_RESPONSE_BYTES + 1)):
            with self.assertRaises(ValueError):
                publication_needed(self.manifest, self.opener(payload))

    def test_unexpected_success_status_fails(self):
        with self.assertRaises(ValueError):
            publication_needed(self.manifest, self.opener(self.entry(), status=206))

    def test_redirects_fail(self):
        with self.assertRaisesRegex(ValueError, "redirected"):
            NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.example/")


if __name__ == "__main__":
    unittest.main()
