"""PR15 finalist hydration: slim rows, bounded schemas, claimed ≠ observed."""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import catalog, hydrate, payment, probe, select, shadow


def _huge_schema(n: int = 400, desc_len: int = 80) -> dict:
    return {
        "type": "object",
        "properties": {
            ("k%d" % i): {"type": "string", "description": "x" * desc_len} for i in range(n)
        },
    }


def _raw(url: str, schema=None, **extra):
    row = {
        "url": url,
        "description": extra.pop("description", "weather forecast"),
        "serviceName": "Weather API",
        "accepts": extra.pop(
            "accepts",
            [
                {
                    "network": payment.BASE_CAIP2,
                    "payTo": "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
                    "amount": "20000",
                    "asset": payment.USDC_BASE,
                }
            ],
        ),
        "extensions": {
            "bazaar": {
                "info": {
                    "input": {
                        "method": "POST",
                        "toolName": extra.pop("toolName", "get_weather"),
                        "type": "http",
                        "bodyType": "json",
                    }
                }
            }
        },
    }
    if schema is not None:
        row["inputSchema"] = schema
        row["outputSchema"] = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    row.update(extra)
    return row


class SlimStaysSlimTests(unittest.TestCase):
    def test_slim_item_drops_schema_even_when_stashed(self):
        stash = {}
        schema = {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        }
        slim = catalog.slim_item(_raw("https://wx.example/slim", schema), "base", stash=stash)
        self.assertNotIn("inputSchema", slim)
        self.assertNotIn("outputSchema", slim)
        blob = json.dumps(slim)
        self.assertLess(len(blob), 8000)
        self.assertTrue(slim["_input_schema_present"])
        self.assertIn("https://wx.example/slim", stash)
        contract = stash["https://wx.example/slim"]
        self.assertEqual(contract["origin"], hydrate.ORIGIN_CLAIMED)
        self.assertEqual(contract["tool_name"], "get_weather")
        self.assertEqual(contract["content_type"], "application/json")
        self.assertEqual((contract.get("input_schema") or {}).get("required"), ["city"])


class HydrationBoundTests(unittest.TestCase):
    def setUp(self):
        self._prev = os.environ.get("LIVE402_CATALOG_DB")
        fd, self._path = tempfile.mkstemp(prefix="live402-hydrate-", suffix=".sqlite")
        os.close(fd)
        os.environ["LIVE402_CATALOG_DB"] = self._path
        shadow.reset()
        hydrate.cache_clear()

    def tearDown(self):
        hydrate.cache_clear()
        shadow.reset()
        try:
            os.remove(self._path)
        except OSError:
            pass
        if self._prev is None:
            os.environ.pop("LIVE402_CATALOG_DB", None)
        else:
            os.environ["LIVE402_CATALOG_DB"] = self._prev

    def test_hydrate_only_top_finalists(self):
        stash = {}
        ranked = []
        for i in range(16):
            raw = _raw(
                "https://wx.example/n%d" % i,
                {
                    "type": "object",
                    "properties": {"q": {"type": "string"}},
                    "required": ["q"],
                },
                toolName="wx_%d" % i,
            )
            slim = catalog.slim_item(raw, "base", stash=stash)
            ranked.append(slim)
        hydrate.hydrate_finalists(ranked, stash=stash, n=8)
        hydrated = [r for r in ranked if r.get("inputSchema")]
        self.assertEqual(len(hydrated), 8)
        for row in ranked[:8]:
            self.assertIn("inputSchema", row)
            self.assertEqual(row["_claimed_contract"]["origin"], hydrate.ORIGIN_CLAIMED)
            self.assertEqual(row["inputSchema"]["required"], ["q"])
        for row in ranked[8:]:
            self.assertNotIn("inputSchema", row)
            self.assertNotIn("_claimed_contract", row)
            self.assertTrue(row.get("_input_schema_present"))

    def test_oversize_schema_is_dropped_not_stored(self):
        huge = _huge_schema(500, 120)
        raw = _json = json.dumps(huge)
        self.assertGreater(len(_json.encode("utf-8")), hydrate.SCHEMA_MAX_BYTES)
        stash = {}
        slim = catalog.slim_item(_raw("https://wx.example/huge", huge), "base", stash=stash)
        ranked = [slim]
        hydrate.hydrate_finalists(ranked, stash=stash, n=5)
        contract = ranked[0].get("_claimed_contract") or {}
        self.assertTrue(contract.get("truncated") or not ranked[0].get("inputSchema"))
        cached = hydrate.cache_get("https://wx.example/huge")
        if cached:
            self.assertIsNone(cached.get("input_schema"))
            self.assertTrue(cached.get("truncated"))

    def test_cache_ttl_and_row_cap(self):
        for i in range(hydrate.CACHE_MAX_ROWS + 12):
            contract = {
                "origin": hydrate.ORIGIN_CLAIMED,
                "method": "POST",
                "content_type": "application/json",
                "tool_name": "t%d" % i,
                "type": "http",
                "input_schema": {"type": "object", "properties": {"n": {"type": "integer"}}},
                "output_schema": None,
                "schema_bytes": 40,
                "truncated": False,
            }
            hydrate.cache_put("https://wx.example/c%d" % i, contract, ttl_s=3600)
        self.assertLessEqual(hydrate.cache_count(), hydrate.CACHE_MAX_ROWS)
        hydrate.cache_put(
            "https://wx.example/expire",
            {
                "origin": hydrate.ORIGIN_CLAIMED,
                "method": "POST",
                "input_schema": {"type": "object"},
                "schema_bytes": 20,
                "truncated": False,
            },
            ttl_s=1,
        )
        self.assertIsNotNone(hydrate.cache_get("https://wx.example/expire"))
        time.sleep(1.1)
        self.assertIsNone(hydrate.cache_get("https://wx.example/expire"))

    def test_claimed_schema_is_not_observed_payment(self):
        catalog_item = catalog.slim_item(
            _raw(
                "https://wx.example/claimed-pay",
                {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
                accepts=[
                    {
                        "network": payment.BASE_CAIP2,
                        "asset": payment.USDC_BASE,
                        "amount": "20000",
                        "payTo": "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
                    },
                    {
                        "network": payment.SOLANA_MAINNET,
                        "asset": payment.USDC_SOLANA_MINT,
                        "amount": "1000",
                        "payTo": payment.DEFAULT_PAYTO_SOLANA,
                    },
                ],
            ),
            "base",
            stash={},
        )
        hydrate.hydrate_finalists(
            [catalog_item],
            stash={
                "https://wx.example/claimed-pay": hydrate.extract_claimed_contract(
                    _raw(
                        "https://wx.example/claimed-pay",
                        {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
                    )
                )
            },
        )
        envelope = {
            "x402Version": 2,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": payment.BASE_CAIP2,
                    "asset": payment.USDC_BASE,
                    "amount": "20000",
                    "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "maxTimeoutSeconds": 60,
                }
            ],
        }
        result = {
            "url": "https://wx.example/claimed-pay",
            "live": True,
            "status": 402,
            "has_402_challenge": True,
            "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "envelope": envelope,
            "accepts": envelope["accepts"],
        }
        result = probe.attach_catalog_fields(result, catalog_item)
        result = probe.attach_invocable_target(result, catalog_item, envelope)
        observed = payment.payment_options_from_result(result)
        self.assertEqual([o.get("rail") for o in observed], ["base"])
        self.assertNotIn("solana", {o.get("rail") for o in observed})
        selected = select.pick_selected_payment(result, "cheapest", None)
        self.assertEqual(selected["rail"], "base")
        self.assertEqual(selected["payTo"], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        claimed = result.get("claimed") or {}
        self.assertIn("solana", {o.get("rail") for o in (claimed.get("payment_options") or [])})
        self.assertEqual((claimed.get("contract") or {}).get("origin"), hydrate.ORIGIN_CLAIMED)
        target_accepts = (result.get("target") or {}).get("accepts") or []
        self.assertEqual(len(target_accepts), 1)
        self.assertNotEqual(claimed.get("payTo"), selected["payTo"])


class UntrustedSchemaTests(unittest.TestCase):
    def test_local_fragment_kept_without_remote_material(self):
        raw = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://listed.example/schema",
            "type": "object",
            "properties": {
                "city": {"type": "string", "$ref": "#/definitions/city"},
            },
            "definitions": {"city": {"type": "string"}},
        }
        cleaned = hydrate.sanitize_untrusted_schema(raw)
        self.assertIsInstance(cleaned, dict)
        self.assertNotIn("$schema", cleaned)
        self.assertNotIn("$id", cleaned)
        self.assertEqual(cleaned["properties"]["city"]["$ref"], "#/definitions/city")
        bounded, _n, trunc = hydrate._bounded_schema(raw)
        self.assertFalse(trunc)
        blob = json.dumps(bounded)
        self.assertNotIn("https://listed.example", blob)
        self.assertIn("#/definitions/city", blob)

    def test_remote_ref_is_refused_not_rewritten(self):
        raw = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://evil.example/schema",
            "$ref": "https://evil.example/remote.json",
            "type": "object",
            "properties": {
                "city": {"type": "string", "$ref": "#/definitions/city"},
                "nested": {"$ref": "//cdn.example/x"},
            },
            "definitions": {"city": {"type": "string"}},
        }
        self.assertIsNone(hydrate.sanitize_untrusted_schema(raw))
        self.assertIsNone(hydrate.forward_untrusted_schema(raw))
        self.assertTrue(hydrate.schema_is_unusable(raw))
        bounded, _n, trunc = hydrate._bounded_schema(raw)
        self.assertIsNone(bounded)
        self.assertTrue(trunc)

    def test_relative_and_dynamic_refs_are_refused(self):
        for raw in (
            {"type": "object", "$ref": "./other.json"},
            {"type": "object", "$dynamicRef": "#node"},
            {"type": "object", "properties": {"x": {"$recursiveRef": "#"}}},
            {"type": "object", "$ref": "#node"},
            {"$ref": ""},
        ):
            self.assertIsNone(hydrate.forward_untrusted_schema(raw), raw)
            self.assertTrue(hydrate.schema_is_unusable(raw), raw)

    def test_claimed_contract_is_untrusted(self):
        stash = {}
        slim = catalog.slim_item(
            _raw("https://wx.example/untrusted", {"type": "object", "properties": {"q": {"type": "string"}}}),
            "base",
            stash=stash,
        )
        hydrate.hydrate_finalists([slim], stash=stash, n=5)
        contract = slim.get("_claimed_contract") or {}
        self.assertEqual(contract.get("origin"), hydrate.ORIGIN_CLAIMED)
        self.assertTrue(contract.get("untrusted"))
        self.assertIn("system prompts", contract.get("client_warning") or "")


class LiveSchemaBoundTests(unittest.TestCase):
    def test_unsafe_live_schema_refused_original_envelope_kept(self):
        original = {
            "$ref": "https://evil.example/full.json",
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "required": ["q"],
        }
        envelope = {
            "x402Version": 2,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": payment.BASE_CAIP2,
                    "asset": payment.USDC_BASE,
                    "amount": "20000",
                    "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "maxTimeoutSeconds": 60,
                }
            ],
            "inputSchema": original,
        }
        result = {
            "url": "https://wx.example/live-ref",
            "live": True,
            "status": 402,
            "has_402_challenge": True,
            "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "envelope": envelope,
            "accepts": envelope["accepts"],
        }
        result = probe.attach_invocable_target(result, None, envelope)
        self.assertIs(result.get("envelope"), envelope)
        self.assertEqual(result["envelope"]["inputSchema"]["$ref"], "https://evil.example/full.json")
        target = result.get("target") or {}
        self.assertIsNone(target.get("inputSchema"))
        self.assertTrue(target.get("schema_refused"))
        self.assertTrue(target.get("untrusted"))
        self.assertFalse(result.get("invocable"))
        self.assertNotEqual(result.get("miss_reason"), "no_input_schema")
        self.assertTrue(result.get("payable"))

    def _payable_live(self, schema, url="https://wx.example/live-bound"):
        envelope = {
            "x402Version": 2,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": payment.BASE_CAIP2,
                    "asset": payment.USDC_BASE,
                    "amount": "20000",
                    "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "maxTimeoutSeconds": 60,
                }
            ],
            "inputSchema": schema,
        }
        result = {
            "url": url,
            "live": True,
            "status": 402,
            "has_402_challenge": True,
            "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "envelope": envelope,
            "accepts": envelope["accepts"],
        }
        return result, envelope

    def _assert_schema_refused(self, schema, url):
        original = json.loads(json.dumps(schema))
        result, envelope = self._payable_live(schema, url)
        result = probe.attach_invocable_target(result, None, envelope)
        self.assertIs(result.get("envelope"), envelope)
        self.assertEqual(result["envelope"]["inputSchema"], original)
        target = result.get("target") or {}
        self.assertIsNone(target.get("inputSchema"))
        self.assertTrue(target.get("schema_refused"))
        self.assertTrue(target.get("untrusted"))
        self.assertFalse(result.get("invocable"))
        self.assertTrue(result.get("payable"))
        self.assertNotEqual(result.get("miss_reason"), "no_input_schema")

    def _assert_schema_usable(self, schema, url):
        original = json.loads(json.dumps(schema))
        result, envelope = self._payable_live(schema, url)
        result = probe.attach_invocable_target(result, None, envelope)
        self.assertIs(result.get("envelope"), envelope)
        self.assertEqual(result["envelope"]["inputSchema"], original)
        target = result.get("target") or {}
        self.assertEqual(target.get("inputSchema"), original)
        self.assertTrue(target.get("untrusted"))
        self.assertNotIn("schema_refused", target)
        self.assertTrue(result.get("invocable"))
        self.assertTrue(result.get("payable"))

    def test_safe_live_schema_still_forwarded_and_marked_untrusted(self):
        envelope = {
            "x402Version": 2,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": payment.BASE_CAIP2,
                    "asset": payment.USDC_BASE,
                    "amount": "20000",
                    "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "maxTimeoutSeconds": 60,
                }
            ],
            "inputSchema": {
                "type": "object",
                "properties": {"q": {"type": "string"}},
                "required": ["q"],
            },
        }
        result = {
            "url": "https://wx.example/live-safe",
            "live": True,
            "status": 402,
            "has_402_challenge": True,
            "payTo": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "envelope": envelope,
            "accepts": envelope["accepts"],
        }
        result = probe.attach_invocable_target(result, None, envelope)
        target = result.get("target") or {}
        self.assertEqual(target.get("inputSchema"), envelope["inputSchema"])
        self.assertTrue(target.get("untrusted"))
        self.assertNotIn("schema_refused", target)
        self.assertTrue(result.get("invocable"))
        self.assertEqual(result.get("schema_source"), "envelope")

    def test_overlimit_required_list_refuses_whole_schema(self):
        names = ["p%02d" % i for i in range(hydrate.SCHEMA_MAX_ITEMS + 1)]
        schema = {
            "type": "object",
            "properties": {name: {"type": "string"} for name in names},
            "required": names,
        }
        self._assert_schema_refused(schema, "https://wx.example/live-required-overflow")

    def test_overlimit_object_keys_refuses_whole_schema(self):
        names = ["k%02d" % i for i in range(hydrate.SCHEMA_MAX_KEYS + 1)]
        schema = {
            "type": "object",
            "properties": {name: {"type": "string"} for name in names},
            "required": ["k00"],
        }
        self._assert_schema_refused(schema, "https://wx.example/live-key-overflow")

    def test_overlimit_string_refuses_whole_schema(self):
        schema = {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "x" * (hydrate.SCHEMA_MAX_STRING + 1)},
            },
            "required": ["q"],
        }
        self._assert_schema_refused(schema, "https://wx.example/live-string-overflow")

    def test_remote_ref_beyond_depth_cutoff_refuses_whole_schema(self):
        nested = {"$ref": "https://evil.example/beyond.json"}
        for _ in range(hydrate.SCHEMA_MAX_DEPTH + 1):
            nested = {"wrap": nested}
        schema = {
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "required": ["q"],
            "extra": nested,
        }
        self._assert_schema_refused(schema, "https://wx.example/live-deep-ref")

    def test_null_const_constraint_is_kept_and_usable(self):
        schema = {
            "type": "object",
            "properties": {
                "flag": {"const": None},
                "q": {"type": "string"},
            },
            "required": ["q"],
        }
        self._assert_schema_usable(schema, "https://wx.example/live-null-const")

    def test_in_limit_required_list_stays_usable(self):
        names = ["p%02d" % i for i in range(hydrate.SCHEMA_MAX_ITEMS)]
        schema = {
            "type": "object",
            "properties": {name: {"type": "string"} for name in names},
            "required": names,
        }
        self._assert_schema_usable(schema, "https://wx.example/live-required-limit")

    def test_required_property_named_dollar_id_is_preserved(self):
        schema = {
            "type": "object",
            "properties": {
                "$id": {"type": "string"},
                "q": {"type": "string"},
            },
            "required": ["$id", "q"],
            "additionalProperties": False,
        }
        self._assert_schema_usable(schema, "https://wx.example/live-prop-id")
        result, envelope = self._payable_live(schema, "https://wx.example/live-prop-id")
        result = probe.attach_invocable_target(result, None, envelope)
        target_schema = (result.get("target") or {}).get("inputSchema") or {}
        self.assertEqual(set((target_schema.get("properties") or {})), {"$id", "q"})
        self.assertEqual(target_schema.get("required"), ["$id", "q"])

    def test_literal_property_named_dollar_ref_is_preserved(self):
        schema = {
            "type": "object",
            "properties": {
                "$ref": {"type": "string"},
                "q": {"type": "string"},
            },
            "required": ["$ref", "q"],
            "additionalProperties": False,
        }
        self._assert_schema_usable(schema, "https://wx.example/live-prop-ref")
        result, envelope = self._payable_live(schema, "https://wx.example/live-prop-ref")
        result = probe.attach_invocable_target(result, None, envelope)
        target_schema = (result.get("target") or {}).get("inputSchema") or {}
        self.assertEqual(set((target_schema.get("properties") or {})), {"$ref", "q"})
        self.assertEqual(target_schema.get("required"), ["$ref", "q"])

    def test_schema_map_keys_preserve_keyword_looking_names(self):
        schema = {
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "patternProperties": {"$id": {"type": "string"}},
            "dependentSchemas": {"$ref": {"type": "object", "properties": {"ok": {"type": "boolean"}}}},
            "required": ["q"],
        }
        self._assert_schema_usable(schema, "https://wx.example/live-schema-maps")

    def test_const_enum_keyword_looking_keys_are_preserved(self):
        schema = {
            "type": "object",
            "properties": {
                "q": {"type": "string"},
                "mode": {
                    "const": {"$ref": "https://example.com/x", "$id": "not-a-keyword"},
                },
                "choice": {
                    "enum": [
                        {"$schema": "https://json-schema.org/draft/2020-12/schema"},
                        {"$anchor": "x"},
                    ],
                },
                "sample": {
                    "default": {"$dynamicRef": "#node"},
                    "examples": [{"$recursiveRef": "#"}],
                },
            },
            "required": ["q"],
        }
        self._assert_schema_usable(schema, "https://wx.example/live-literal-keywords")

    def test_anchor_dependent_local_ref_is_refused(self):
        schema = {
            "type": "object",
            "$anchor": "root",
            "properties": {"q": {"type": "string"}},
            "required": ["q"],
        }
        self._assert_schema_refused(schema, "https://wx.example/live-anchor")

    def test_nested_id_with_local_ref_is_refused(self):
        schema = {
            "type": "object",
            "properties": {
                "q": {"type": "string"},
                "inner": {
                    "$id": "https://listed.example/nested",
                    "$ref": "#",
                },
            },
            "required": ["q"],
        }
        self._assert_schema_refused(schema, "https://wx.example/live-nested-id")


if __name__ == "__main__":
    unittest.main()
