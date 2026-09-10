"""Codec detect from live challenge wire. No network or merchant payments."""

import copy
import json
import unittest
from pathlib import Path

from live402 import batch_codec, route_binding as rb

FIXTURES = Path(__file__).parent / "fixtures"


def load_json(name):
    return json.loads((FIXTURES / name).read_text())


def cases():
    wire = load_json("batch-observation-wire.json")
    generic = load_json("algorand-generic-v5.json")
    base_mpp = load_json("base-native-mpp-v5.json")
    algo_mpp = load_json("algorand-mpp-charge-v5.json")
    manifests = load_json("algorand-manifest-v2.json")
    invoice = next(
        item
        for item in manifests
        if item["request"]["merchant_profile"] == "algorand-aggregate-invoice-v1"
    )
    multi = next(
        item
        for item in manifests
        if item["request"]["merchant_profile"] == "algorand-atomic-multi-item-v1"
    )
    return (
        ("exact", "base-x402-batch-v1", wire[0]["challenge"], wire[0]["request"]["buyer_limits"]),
        ("sess", "solana-mpp-session-v1", wire[1]["challenge"], wire[1]["request"]["buyer_limits"]),
        ("atom", "algorand-atomic-batch-v1", wire[2]["challenge"], wire[2]["request"]["buyer_limits"]),
        ("atom", "algorand-atomic-two-item-v1", generic["challenge"], generic["request"]["buyer_limits"]),
        ("mpp", "base-mpp-charge-v1", base_mpp["challenge"], base_mpp["request"]["buyer_limits"]),
        ("mpp", "algorand-mpp-charge-v1", algo_mpp[0]["challenge"], algo_mpp[0]["request"]["buyer_limits"]),
        ("atom", "algorand-atomic-multi-item-v1", multi["challenge"], multi["request"]["buyer_limits"]),
        ("inv", "algorand-aggregate-invoice-v1", invoice["challenge"], invoice["request"]["buyer_limits"]),
    )


class CodecDetectTests(unittest.TestCase):
    def test_each_codec_detects_from_live_challenge(self):
        seen = set()
        for codec, profile, challenge, limits in cases():
            seen.add(codec)
            with self.subTest(profile=profile):
                self.assertEqual(batch_codec.detect(challenge), (codec, profile))
                self.assertEqual(batch_codec.PROFILE_CODEC[profile], codec)
                inferred_codec, inferred_profile = batch_codec.limits_match(limits)
                self.assertEqual(inferred_codec, codec)
                if inferred_profile is not None:
                    self.assertEqual(inferred_profile, profile)
        self.assertEqual(seen, set(batch_codec.CODECS))

    def test_ordinary_exact_x402_is_unknown(self):
        challenge = {
            "status": 402,
            "bodyText": json.dumps(
                {
                    "x402Version": 2,
                    "resource": {"url": "https://merchant.example/paid", "mimeType": "application/json"},
                    "accepts": [
                        {
                            "scheme": "exact",
                            "network": "eip155:8453",
                            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                            "amount": "1000",
                            "payTo": "0x1111111111111111111111111111111111111111",
                            "maxTimeoutSeconds": 60,
                        }
                    ],
                }
            ),
            "paymentRequired": None,
            "wwwAuthenticate": None,
        }
        with self.assertRaises(rb.BindingError):
            batch_codec.detect(challenge)

    def test_empty_and_non_402_refuse(self):
        exact = cases()[0][2]
        with self.assertRaises(rb.BindingError):
            batch_codec.detect({**exact, "status": 200})
        with self.assertRaises(rb.BindingError):
            batch_codec.detect(
                {
                    "status": 402,
                    "bodyText": "",
                    "paymentRequired": None,
                    "wwwAuthenticate": None,
                }
            )

    def test_ambiguous_payment_and_body_refuse(self):
        exact = copy.deepcopy(cases()[0][2])
        sess = cases()[1][2]
        exact["wwwAuthenticate"] = sess["wwwAuthenticate"]
        with self.assertRaises(rb.BindingError):
            batch_codec.detect(exact)

    def test_native_multi_offer_still_detects_mpp(self):
        from test_native_charge_selection import mixed

        base_mpp = load_json("base-native-mpp-v5.json")
        challenge = mixed(base_mpp)["challenge"]
        self.assertEqual(batch_codec.detect(challenge), ("mpp", "base-mpp-charge-v1"))

    def test_mixed_native_intents_refuse(self):
        challenge = {
            "status": 402,
            "bodyText": "",
            "paymentRequired": None,
            "wwwAuthenticate": (
                'Payment id="a", realm="merchant.example", method="evm", '
                'intent="charge", request="e30", expires="2026-09-08T17:01:00.000Z", '
                'Payment id="b", realm="merchant.example", method="solana", '
                'intent="session", request="e30", expires="2026-09-08T17:01:00.000Z"'
            ),
        }
        with self.assertRaises(rb.BindingError):
            batch_codec.detect(challenge)

    def test_limits_codec_mismatch_is_not_the_detected_codec(self):
        _codec, _profile, challenge, _limits = cases()[0]
        sess_limits = cases()[1][3]
        self.assertEqual(batch_codec.detect(challenge)[0], "exact")
        self.assertEqual(batch_codec.limits_match(sess_limits)[0], "sess")

    def test_identity_is_stable(self):
        self.assertEqual(
            batch_codec.identity("exact"),
            {"job": "chk_grp", "codec": "exact", "label": "Check group offer"},
        )
        with self.assertRaises(rb.BindingError):
            batch_codec.identity("unknown")


if __name__ == "__main__":
    unittest.main()
