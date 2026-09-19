import copy
import json
import unittest
from pathlib import Path

import signal402
from signal402.verify import ReceiptError, canonical, leaf_hash, verify_inclusion

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "route-binding-v1.json"


def load():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class VerifyFixtureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = load()
        self.vkey = self.fixture["trusted_vkey"]

    def test_every_conformance_case_verifies(self):
        for case in self.fixture["cases"]:
            with self.subTest(rail=case["rail"]):
                out = signal402.verify_route_receipt(case["response"], trusted_log_vkey=self.vkey)
                self.assertEqual(out["origin"], "402signal.com/pq/log")
                self.assertEqual(out["event_version"], "402signal.route_decision.v4")
                self.assertEqual(out["index"], case["response"]["pq_trust"]["transparency"]["receipt"]["index"])
                self.assertEqual(len(out["root"]), 64)

    def test_receipt_alone_verifies_signature_and_inclusion(self):
        receipt = self.fixture["cases"][0]["response"]["pq_trust"]["transparency"]["receipt"]
        out = signal402.verify_receipt(receipt, self.vkey)
        self.assertEqual(out["leaf_hash"], receipt["leaf_hash"])
        self.assertEqual(out["tree_size"], 1)

    def test_tampering_fails_closed(self):
        base = self.fixture["cases"][0]["response"]

        def tampered(mutate):
            copy_ = copy.deepcopy(base)
            mutate(copy_["pq_trust"]["transparency"])
            return copy_

        def other_root(checkpoint):
            # Line 2 of a C2SP checkpoint is the base64 root hash.
            lines = checkpoint.split("\n")
            root = lines[2]
            lines[2] = ("A" if root[0] != "A" else "B") + root[1:]
            return "\n".join(lines)

        cases = {
            "leaf hash": lambda tr: tr["receipt"].__setitem__("leaf_hash", "00" * 32),
            "index": lambda tr: tr["receipt"].__setitem__("index", 1),
            "signature": lambda tr: tr["receipt"].__setitem__(
                "checkpoint", tr["receipt"]["checkpoint"].replace("bMKV", "cMKV")),
            "root": lambda tr: tr["receipt"].__setitem__(
                "checkpoint", other_root(tr["receipt"]["checkpoint"])),
            "salt": lambda tr: tr["reveal"].__setitem__("salt", "11" * 32),
            "evidence": lambda tr: tr["reveal"]["evidence"]["binding"].__setitem__("selected_index", 1),
            "commitment": lambda tr: tr["reveal"].__setitem__("commitment", "ab" * 32),
            "nonce": lambda tr: tr["reveal"].__setitem__("nonce", "ff" * 32),
            "version": lambda tr: tr["reveal"].update({"event_version": "402signal.route_decision.v3", "type": "402signal.route_decision.v3"}),
            "extra reveal key": lambda tr: tr["reveal"].__setitem__("extra", 1),
        }
        for name, mutate in cases.items():
            with self.subTest(tamper=name):
                with self.assertRaises(ReceiptError):
                    signal402.verify_route_receipt(tampered(mutate), trusted_log_vkey=self.vkey)

    def test_wrong_or_missing_key_is_rejected(self):
        response = self.fixture["cases"][0]["response"]
        with self.assertRaises(ReceiptError):
            signal402.verify_route_receipt(response, trusted_log_vkey="")
        other = "402signal.com/pq/log+6cc295a4+AQOhB7/zzhC+HXDdGOdLwJln5NYwm6UNXx3chmQSVTG5"
        with self.assertRaises(ReceiptError):
            signal402.verify_route_receipt(response, trusted_log_vkey=other)
        renamed = "evil.example/log" + self.vkey[len("402signal.com/pq/log"):]
        with self.assertRaises(ReceiptError):
            signal402.verify_route_receipt(response, trusted_log_vkey=renamed)


class PrimitiveTests(unittest.TestCase):
    def test_canonical_json_sorts_keys_and_keeps_integers(self):
        self.assertEqual(canonical({"b": 1, "a": "x", "c": [True, None, 2.5]}), b'{"a":"x","b":1,"c":[true,null,2.5]}')
        self.assertEqual(canonical({"é": "ü"}), '{"é":"ü"}'.encode("utf-8"))
        with self.assertRaises(ReceiptError):
            canonical({"n": float("inf")})

    def test_decimal_values_lay_out_as_javascript_does(self):
        # Vectors are JSON.stringify output from Node for the same doubles
        # (RFC 8785 section 3.2.2.3). The server hashes challenges this way.
        vectors = [
            (67234.12, "67234.12"),
            (1.0, "1"),
            (-0.0, "0"),
            (-2.5, "-2.5"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-9, "1.5e-9"),
            (1e21, "1e+21"),
            (1.5e22, "1.5e+22"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (9007199254740992.0, "9007199254740992"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ]
        for value, expected in vectors:
            self.assertEqual(canonical(value).decode(), expected, repr(value))
        self.assertEqual(
            canonical({"example": {"price": 67234.12, "supply": 1.0, "tick": 1e-7}}),
            b'{"example":{"price":67234.12,"supply":1,"tick":1e-7}}',
        )
        with self.assertRaises(ReceiptError):
            canonical({"n": float("nan")})

    def test_inclusion_path_folds_to_the_root(self):
        leaves = [leaf_hash(bytes([i])) for i in range(5)]

        def mth(hs):
            if len(hs) == 1:
                return hs[0]
            k = 1
            while k * 2 < len(hs):
                k *= 2
            from signal402.verify import node_hash
            return node_hash(mth(hs[:k]), mth(hs[k:]))

        root = mth(leaves)
        # PATH(3, D[5]) = [leaf2, mth(leaf0,leaf1), mth(leaf4)]
        from signal402.verify import node_hash
        path = [leaves[2], node_hash(leaves[0], leaves[1]), leaves[4]]
        self.assertTrue(verify_inclusion(3, leaves[3], path, root, 5))
        self.assertFalse(verify_inclusion(2, leaves[3], path, root, 5))
        self.assertFalse(verify_inclusion(3, leaves[3], path[:-1], root, 5))


if __name__ == "__main__":
    unittest.main()
