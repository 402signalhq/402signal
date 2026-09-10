"""Challenge→binding adapters. Synthetic seller shapes; no live network or payment."""

import base64
import copy
import io
import json
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

from live402 import payment, probe, route_binding as rb
from test_route_binding import bound_winner


STOCK_URL = "https://seller.example/v1/market/regime/latest"
HASH_URL = "https://seller.example/api/hash"
ICON = "https://seller.example/icon.png"


def _accept(url=STOCK_URL, extra=None):
    acc = {
        "scheme": "exact",
        "network": payment.BASE_CAIP2,
        "asset": payment.USDC_BASE,
        "amount": "10000",
        "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "maxTimeoutSeconds": 300,
        "extra": {"name": "USD Coin", "version": "2"},
    }
    if extra:
        acc.update(extra)
    return acc


def _resource(url, **extra):
    resource = {
        "url": url,
        "description": "Synthetic observational resource",
        "mimeType": "application/json",
        "serviceName": "Seller Example",
        "tags": ["finance", "example"],
        "iconUrl": ICON,
    }
    resource.update(extra)
    return resource


def _stock_envelope(url=STOCK_URL):
    return {
        "x402Version": 2,
        "resource": _resource(url),
        "accepts": [_accept(url)],
        "extensions": {"bazaar": {"info": {"input": {"type": "http", "method": "GET"}}}},
    }


def _hash_envelope(url=HASH_URL):
    return {
        "x402Version": 2,
        "error": "Payment required",
        "resource": _resource(url, serviceName="Hash", tags=["hash", "encoding"]),
        "accepts": [
            _accept(url, extra={"outputSchema": {"type": "object", "properties": {"hex": {"type": "string"}}}}),
            {
                "scheme": "upto",
                "network": payment.BASE_CAIP2,
                "asset": payment.USDC_BASE,
                "amount": "1000",
                "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "maxTimeoutSeconds": 300,
                "extra": {"name": "USD Coin", "version": "2"},
            },
        ],
        "extensions": {
            "bazaar": {"info": {"input": {"type": "http", "method": "POST"}}},
            "builder-code": {"info": {"a": "app_one"}, "schema": {"type": "object"}},
            "payment-identifier": {"info": {"required": False}, "schema": {"type": "object"}},
        },
    }


def _header(env):
    return {"payment-required": base64.b64encode(json.dumps(env, separators=(",", ":")).encode()).decode()}


def _observe_probe(url, headers, body):
    opener = MagicMock()
    opener.open.side_effect = urllib.error.HTTPError(
        url, 402, "Payment Required", headers, io.BytesIO(body)
    )
    with patch("live402.probe._opener", return_value=opener):
        return probe._one_request(url, "GET", pinned_addrs=[("fixture",)])


def _bound_with(env, url):
    result = bound_winner()
    result["url"] = url
    result["payTo"] = env["accepts"][0]["payTo"]
    result["envelope"] = env
    option = payment.validate_observed_accept(env["accepts"][0], env)
    result["selected_payment"] = payment.selected_payment_fields(option)
    result["binding_observation"] = {
        "request": rb.request_context(url, "GET"),
        "observed_at": 1000,
        "quote_sha256": rb.digest(env),
    }
    return result


class ChallengeBindingAdapterTests(unittest.TestCase):
    def test_stock_trends_nested_payment_required_and_icon_bind(self):
        env = _stock_envelope()
        wrapper = {
            "error": "payment_required",
            "protocol": "x402",
            "resource": STOCK_URL,
            "payment_required": env,
            "catalog": {"docs": "https://seller.example/docs"},
        }
        raw = json.dumps(wrapper).encode()
        observed = rb.observed_challenge(402, _header(env), raw)
        self.assertEqual(rb.canonical(observed), rb.canonical(env))
        self.assertTrue(
            rb._resource_matches_context(observed["resource"], rb.request_context(STOCK_URL, "GET"))
        )
        binding = rb.build(
            _bound_with(observed, STOCK_URL),
            {"need": "weather", "require_route_binding": True},
            now=1001,
        )
        self.assertEqual(binding["request"]["url"], STOCK_URL)
        self.assertEqual(binding["selected_index"], 0)

    def test_agent402_hash_extensions_and_output_schema_bind(self):
        env = _hash_envelope()
        body = json.dumps({"altPayment": {"protocol": "proof-of-work"}}).encode()
        observed = rb.observed_challenge(402, _header(env), body)
        self.assertEqual(rb.canonical(observed), rb.canonical(env))
        self.assertTrue(
            rb._resource_matches_context(observed["resource"], rb.request_context(HASH_URL, "GET"))
        )
        selected = payment.selected_payment_fields(
            payment.validate_observed_accept(observed["accepts"][0], observed)
        )
        self.assertEqual(rb.selected_index(observed, selected), 0)
        binding = rb.build(
            _bound_with(observed, HASH_URL),
            {"need": "weather", "require_route_binding": True},
            now=1001,
        )
        self.assertEqual(binding["selected_index"], 0)

    def test_catalog_wrapper_on_body_projects_to_header(self):
        env = _stock_envelope()
        body = json.dumps({**env, "catalog": {"docs": "https://seller.example/llms.txt"}}).encode()
        observed = rb.observed_challenge(402, _header(env), body)
        self.assertEqual(rb.canonical(observed), rb.canonical(env))

    def test_nested_x402_wrapper_agrees_with_header(self):
        env = _stock_envelope()
        body = json.dumps({"error": {"code": "PAYMENT_REQUIRED"}, "x402": env}).encode()
        observed = rb.observed_challenge(402, _header(env), body)
        self.assertEqual(rb.canonical(observed), rb.canonical(env))

    def test_true_resource_url_mismatch_stays_invalid(self):
        env = _stock_envelope("https://seller.example/other")
        observed = rb.observed_challenge(402, _header(env), json.dumps(env).encode())
        self.assertFalse(
            rb._resource_matches_context(observed["resource"], rb.request_context(STOCK_URL, "GET"))
        )
        with self.assertRaises(rb.BindingError) as exc:
            rb.build(
                _bound_with(observed, STOCK_URL),
                {"need": "weather", "require_route_binding": True},
                now=1001,
            )
        self.assertEqual(str(exc.exception), "resource_changed")

    def test_header_body_accept_disagreement_stays_ambiguous(self):
        env = _stock_envelope()
        body_env = copy.deepcopy(env)
        body_env["accepts"][0]["outputSchema"] = {"type": "object"}
        with self.assertRaises(rb.BindingError) as exc:
            rb.observed_challenge(402, _header(env), json.dumps(body_env).encode())
        self.assertEqual(str(exc.exception), "ambiguous_challenge")

    def test_disagreeing_payment_requirements_alias_fails_closed(self):
        env = _stock_envelope()
        body = {**env, "paymentRequirements": [{**env["accepts"][0], "amount": "1"}]}
        with self.assertRaises(rb.BindingError) as exc:
            rb.observed_challenge(402, {}, json.dumps(body).encode())
        self.assertEqual(str(exc.exception), "ambiguous_challenge")

    def test_matching_payment_requirements_alias_is_projected(self):
        env = _stock_envelope()
        body = {**env, "paymentRequirements": env["accepts"]}
        observed = rb.observed_challenge(402, {}, json.dumps(body).encode())
        self.assertEqual(rb.canonical(observed), rb.canonical(env))
        self.assertNotIn("paymentRequirements", observed)

    def test_floats_in_bazaar_examples_remain_invalid_json(self):
        env = _stock_envelope()
        env["extensions"]["bazaar"]["info"]["example"] = {"lat": 38.8977}
        with self.assertRaises(rb.BindingError) as exc:
            rb.observed_challenge(402, {}, json.dumps(env).encode())
        self.assertEqual(str(exc.exception), "invalid_json")

    def test_unknown_extension_still_fails(self):
        env = _stock_envelope()
        env["extensions"]["new-spending-mode"] = {"info": {}}
        with self.assertRaises(rb.BindingError) as exc:
            rb.observed_challenge(402, {}, json.dumps(env).encode())
        self.assertEqual(str(exc.exception), "unsupported_extension")

    def test_icon_url_is_hashed_not_rewritten(self):
        env = _stock_envelope()
        left = rb.digest(env)
        env["resource"]["iconUrl"] = "https://seller.example/other.png"
        self.assertNotEqual(left, rb.digest(env))

    def test_probe_observation_for_stock_and_hash_shapes(self):
        cases = (
            (
                STOCK_URL,
                _stock_envelope(),
                json.dumps({"error": "payment_required", "payment_required": _stock_envelope()}).encode(),
            ),
            (
                HASH_URL,
                _hash_envelope(),
                json.dumps({"altPayment": {"protocol": "proof-of-work"}}).encode(),
            ),
        )
        for url, env, body in cases:
            with self.subTest(url=url):
                snap = _observe_probe(url, _header(env), body)
                self.assertIsNotNone(snap["binding_observation"])
                self.assertEqual(snap["binding_observation"]["request"]["url"], url)
                self.assertEqual(snap["binding_observation"]["quote_sha256"], rb.digest(env))
                self.assertIsNone(snap.get("binding_error_reason"))

    def test_probe_keeps_true_accept_mismatch_unbound(self):
        env = _stock_envelope()
        body_env = copy.deepcopy(env)
        body_env["accepts"][0]["amount"] = "1"
        snap = _observe_probe(STOCK_URL, _header(env), json.dumps(body_env).encode())
        self.assertTrue(snap["live"])
        self.assertIsNone(snap["binding_observation"])
        self.assertEqual(snap["binding_error_reason"], "ambiguous_challenge")


if __name__ == "__main__":
    unittest.main()
