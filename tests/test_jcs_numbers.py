"""RFC 8785 number layout: Python must emit exactly what JavaScript's String(Number) emits."""

from __future__ import annotations

import unittest

from live402.pq import jcs
from live402 import route_binding as rb

# (JSON literal, String(Number(literal)) as printed by Node 24). Generated with
# node -e 'console.log(lits.map(l=>[l,String(Number(l))]))' on 2026-09-13.
ES6_VECTORS = [
    ("67234.12", "67234.12"), ("1.42", "1.42"), ("-0.65", "-0.65"), ("0.1", "0.1"), ("5.0", "5"),
    ("1e21", "1e+21"), ("1e-7", "1e-7"), ("0.000001", "0.000001"),
    ("123456789012345680000", "123456789012345680000"), ("5e-324", "5e-324"), ("1.5e-7", "1.5e-7"),
    ("0.5", "0.5"), ("100.0", "100"), ("1e16", "10000000000000000"),
    ("1.7976931348623157e308", "1.7976931348623157e+308"), ("2.5e-5", "0.000025"),
    ("1234.5e-10", "1.2345e-7"), ("0.000015", "0.000015"), ("-0.0", "0"), ("1e-6", "0.000001"),
    ("1e-5", "0.00001"), ("12345678901234.5", "12345678901234.5"),
    ("0.30000000000000004", "0.30000000000000004"), ("1e15", "1000000000000000"),
    ("9007199254740992", "9007199254740992"), ("4.35", "4.35"), ("2e-7", "2e-7"), ("123e-20", "1.23e-18"),
    ("-1234.5e-10", "-1.2345e-7"), ("148.2", "148.2"), ("3520.45", "3520.45"), ("2.18", "2.18"),
]


class Es6NumberTests(unittest.TestCase):
    def test_every_vector_matches_javascript(self):
        for literal, expected in ES6_VECTORS:
            with self.subTest(literal=literal):
                self.assertEqual(jcs._serialize_number(float(literal)), expected)

    def test_integers_and_integral_floats_agree(self):
        self.assertEqual(jcs.canonicalize({"n": 5}), b'{"n":5}')
        self.assertEqual(jcs.canonicalize({"n": 5.0}), b'{"n":5}')
        self.assertEqual(jcs.canonicalize([0.000025, -0.65, 67234.12]), b"[0.000025,-0.65,67234.12]")

    def test_non_finite_is_refused(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(jcs.JCSError):
                jcs.canonicalize({"n": value})

    def test_binding_profile_accepts_finite_floats_within_the_safe_range(self):
        env = {"x402Version": 2, "accepts": [], "extensions": {"bazaar": {"example": {"price": 67234.12, "change": -0.65, "tiny": 2.5e-5}}}}
        self.assertEqual(
            rb.canonical(env),
            b'{"accepts":[],"extensions":{"bazaar":{"example":{"change":-0.65,"price":67234.12,"tiny":0.000025}}},"x402Version":2}',
        )
        for bad in ({"n": float("inf")}, {"n": 2.0 ** 53 + 2}, {"n": 1e300}):
            with self.subTest(bad=bad), self.assertRaises(rb.BindingError):
                rb.canonical(bad)


if __name__ == "__main__":
    unittest.main()
