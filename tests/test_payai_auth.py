"""Synthetic merchant-auth keys only. No provider or payment network calls."""
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
import unittest
from unittest.mock import patch
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from live402 import facilitator, payai_auth

VERIFY = "https://facilitator.payai.network/verify"
SETTLE = "https://facilitator.payai.network/settle"


def encoded_key(key):
    return base64.b64encode(key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())).decode()


def unpack(token):
    def decode(segment):
        return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
    header, claims, signature = token.split(".")
    return json.loads(decode(header)), json.loads(decode(claims)), decode(signature), (header + "." + claims).encode()


class PayAIAuthentication(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        payai_auth._cache = None
        self.addCleanup(setattr, payai_auth, "_cache", None)
        # Public deterministic test seed. Never fund it or use for a real account.
        self.key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        self.secret = encoded_key(self.key)

    def credentials(self, secret=None, kid="synthetic-key-id"):
        os.environ["PAYAI_API_KEY_ID"] = kid
        os.environ["PAYAI_API_KEY_SECRET"] = self.secret if secret is None else secret

    def headers(self, wall=1000, mono=100, method="POST", url=VERIFY):
        with patch.object(payai_auth.time, "time", return_value=wall), patch.object(payai_auth.time, "monotonic", return_value=mono):
            return payai_auth.headers_for(method, url)

    def token(self, **kwargs):
        return self.headers(**kwargs)["Authorization"].removeprefix("Bearer ")

    def test_pkcs8_eddsa_signature_and_exact_protocol_claims(self):
        self.credentials()
        token = self.token()
        header, claims, signature, signed = unpack(token)
        self.assertEqual(header, {"alg": "EdDSA", "typ": "JWT", "kid": "synthetic-key-id"})
        self.assertEqual(set(claims), {"sub", "iss", "iat", "exp", "jti"})
        self.assertEqual(claims["sub"], "synthetic-key-id")
        self.assertEqual(claims["iss"], "payai-merchant")
        self.assertEqual((claims["iat"], claims["exp"]), (1000, 1120))
        self.assertEqual(uuid.UUID(claims["jti"]).version, 4)
        self.assertEqual(len(signature), 64)
        self.assertNotIn("=", token)
        self.key.public_key().verify(signature, signed)

    def test_optional_secret_prefix_and_outer_whitespace(self):
        self.credentials("  payai_sk_" + self.secret + " \n")
        token = self.token()
        _header, _claims, signature, signed = unpack(token)
        self.key.public_key().verify(signature, signed)

    def test_token_cache_reuses_until_refresh_margin(self):
        self.credentials()
        first = self.token()
        self.assertEqual(first, self.token(wall=1089, mono=189))
        renewed = self.token(wall=1090, mono=190)
        self.assertNotEqual(first, renewed)
        self.assertEqual(unpack(renewed)[1]["iat"], 1090)
        self.assertNotEqual(unpack(first)[1]["jti"], unpack(renewed)[1]["jti"])

    def test_expired_token_is_not_returned(self):
        self.credentials()
        first = self.token()
        renewed = self.token(wall=2000, mono=1100)
        self.assertNotEqual(first, renewed)
        self.assertEqual(unpack(renewed)[1]["exp"], 2120)

    def test_monotonic_age_limits_reuse_when_wall_clock_stalls(self):
        self.credentials()
        first = self.token()
        self.assertNotEqual(first, self.token(wall=1000, mono=190))

    def test_backward_wall_or_monotonic_clock_invalidates_cache(self):
        self.credentials()
        first = self.token()
        self.assertNotEqual(first, self.token(wall=999, mono=101))
        earlier = self.token(wall=999, mono=101)
        self.assertNotEqual(earlier, self.token(wall=999, mono=100))

    def test_invalid_clock_fails_closed_and_drops_cache(self):
        self.credentials()
        self.token()
        for value in [float("nan"), float("inf"), -1, 2**54]:
            with self.subTest(value=value):
                self.assertIsNone(self.headers(wall=value))
                self.assertIsNone(payai_auth._cache)

    def test_key_id_and_secret_rotation_invalidate_cache(self):
        self.credentials()
        first = self.token()
        os.environ["PAYAI_API_KEY_ID"] = "rotated-id"
        second = self.token()
        self.assertNotEqual(first, second)
        self.assertEqual(unpack(second)[0]["kid"], "rotated-id")
        replacement = Ed25519PrivateKey.from_private_bytes(bytes(reversed(range(32))))
        os.environ["PAYAI_API_KEY_SECRET"] = encoded_key(replacement)
        third = self.token()
        self.assertNotEqual(second, third)
        replacement.public_key().verify(unpack(third)[2], unpack(third)[3])

    def test_invalid_rotated_secret_never_falls_back_to_old_token(self):
        self.credentials()
        self.token()
        os.environ["PAYAI_API_KEY_SECRET"] = "private-invalid-sentinel"
        self.assertIsNone(self.headers())
        self.assertIsNone(payai_auth._cache)

    def test_cache_is_single_entry_and_suppresses_concurrent_signing(self):
        self.credentials()
        with patch.object(payai_auth, "_mint", wraps=payai_auth._mint) as mint, patch.object(payai_auth.time, "time", return_value=1000), patch.object(payai_auth.time, "monotonic", return_value=100):
            with ThreadPoolExecutor(max_workers=16) as workers:
                headers = list(workers.map(lambda _: payai_auth.headers_for("POST", VERIFY), range(64)))
        self.assertEqual(mint.call_count, 1)
        self.assertEqual(len({row["Authorization"] for row in headers}), 1)
        self.assertNotIn("Bearer", repr(payai_auth._cache))
        self.assertNotIn(self.secret, repr(payai_auth._cache))

    def test_partial_pair_fails_closed_even_with_legacy_bearer(self):
        os.environ["PAYAI_API_KEY"] = "legacy-bearer"
        os.environ["PAYAI_API_KEY_ID"] = "synthetic-key-id"
        self.assertIsNone(self.headers())
        os.environ.pop("PAYAI_API_KEY_ID")
        os.environ["PAYAI_API_KEY_SECRET"] = self.secret
        self.assertIsNone(self.headers())

    def test_explicit_access_token_override_and_legacy_compatibility(self):
        os.environ["PAYAI_API_KEY"] = "legacy-bearer"
        self.assertEqual(self.headers(), {"Authorization": "Bearer legacy-bearer"})
        self.credentials()
        self.assertNotEqual(self.headers()["Authorization"], "Bearer legacy-bearer")
        os.environ["PAYAI_ACCESS_TOKEN"] = "operator-managed-token"
        os.environ["PAYAI_API_KEY_SECRET"] = "invalid-pair-overridden-deliberately"
        self.assertEqual(self.headers(), {"Authorization": "Bearer operator-managed-token"})
        self.assertIsNone(payai_auth._cache)

    def test_unconfigured_free_tier_remains_anonymous(self):
        self.assertEqual(self.headers(), {})
        self.assertEqual(facilitator._auth_headers("solana", "POST", VERIFY), {})

    def test_non_ed25519_pkcs8_and_raw_ed25519_seed_rejected(self):
        wrong = ec.generate_private_key(ec.SECP256R1())
        for secret in [encoded_key(wrong), base64.b64encode(bytes(range(32))).decode(), "not-base64", "A" * 4097]:
            with self.subTest(format="invalid-key-material"):
                self.credentials(secret)
                self.assertIsNone(self.headers())

    def test_bearer_header_injection_and_secret_as_bearer_rejected(self):
        for variable in ["PAYAI_ACCESS_TOKEN", "PAYAI_API_KEY"]:
            for token in ["token\r\nX-Header: injected", "two tokens", "payai_sk_" + self.secret, "x" * 8193]:
                with patch.dict(os.environ, {variable: token}, clear=True):
                    self.assertIsNone(self.headers())

    def test_key_id_bounds_and_controls_rejected(self):
        for kid in ["x" * 257, "id\ncontrol", "id with spaces", "unicode-\N{SNOWMAN}"]:
            self.credentials(kid=kid)
            self.assertIsNone(self.headers())

    def test_credentials_never_returned_for_other_hosts_methods_or_paths(self):
        self.credentials()
        for url in ["http://facilitator.payai.network/verify", "https://evil.example/verify",
                    "https://facilitator.payai.network.evil.example/verify", "https://facilitator.payai.network@evil.example/verify",
                    "https://facilitator.payai.network/verify?redirect=1", "https://facilitator.payai.network/verify#fragment",
                    "https://facilitator.payai.network:8443/verify", "https://facilitator.payai.network/discovery/resources"]:
            with self.subTest(url=url):
                self.assertIsNone(self.headers(url=url))
        self.assertIsNone(self.headers(method="GET"))
        self.assertIsNotNone(self.headers(method="GET", url="https://facilitator.payai.network/supported"))
        self.assertIsNone(facilitator._auth_headers("solana", "POST", facilitator.CDP_VERIFY_URL))

    def test_invalid_paid_configuration_returns_generic_error_before_network(self):
        self.credentials("secret-parser-error-must-not-appear")
        with patch.object(facilitator, "post_json") as post:
            result = facilitator._call("solana", VERIFY, {}, 1)
        post.assert_not_called()
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "payai_auth_invalid")
        self.assertNotIn("secret-parser", repr(result))

    def test_auth_http_or_transport_errors_never_retry_settlement(self):
        self.credentials()
        for response in [(401, {"error": "expired"}), (403, {}), (503, {}), (None, {})]:
            with patch.object(facilitator, "post_json", return_value=response) as post:
                result = facilitator._call("solana", SETTLE, {}, 1)
            self.assertFalse(result.ok)
            post.assert_called_once()

    def test_verify_and_settle_share_cached_jwt_without_mutating_request_body(self):
        self.credentials()
        body = {"synthetic": {"value": 1}}
        with patch.object(facilitator, "post_json", return_value=(200, {})) as post:
            facilitator._call("solana", VERIFY, body, 1)
            facilitator._call("solana", SETTLE, body, 1)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args_list[0].kwargs["headers"], post.call_args_list[1].kwargs["headers"])
        self.assertEqual(body, {"synthetic": {"value": 1}})

    def test_cdp_auth_path_and_algorand_anonymous_path_unchanged(self):
        with patch.object(facilitator.cdp_auth, "bearer_for", return_value="cdp-token") as cdp:
            self.assertEqual(facilitator._auth_headers("base", "POST", facilitator.CDP_VERIFY_URL), {"Authorization": "Bearer cdp-token"})
        cdp.assert_called_once_with("POST", facilitator.CDP_VERIFY_URL)
        self.assertEqual(facilitator._auth_headers("algorand", "POST", facilitator.GOPLAUSIBLE_VERIFY_URL), {})


if __name__ == "__main__":
    unittest.main()
