"""Discovery ranking under a price bound, own-origin exclusion, and winner alignment
under a network lock. Every case comes from the paid captures of 2026-09-14."""

from __future__ import annotations

import os
import unittest

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import payment, policy, probe, route, select

NEED = "agent wallet balance lookup"
ALGO_NET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="
ALGO_USDC = "31566704"
ALGO_PAYTO = "N2JSJZCSORMYGYO2NSIYRUEMBFRHEOMYODVXV2MXYYHB5H2JVUGG6NJ4NQ"
BASE_PAYTO = "0x4f4C15d9bD7c796A9f9B769b78323EA3E0054104"
SOL_PAYTO = "3tVQUidPKBG4VfASUzrHYpCzdKr8RmJEPhv9GcAGvUTg"
URL = "https://x-data-gateway.example/users/search"
BASE_ACCEPT = {
    "scheme": "exact", "network": payment.BASE_CAIP2, "asset": payment.USDC_BASE, "amount": "8000",
    "payTo": BASE_PAYTO, "maxTimeoutSeconds": 60, "extra": {"name": "USD Coin", "version": "2"},
}
SOL_ACCEPT = {
    "scheme": "exact", "network": payment.SOLANA_MAINNET, "asset": payment.USDC_SOLANA_MINT, "amount": "8000",
    "payTo": SOL_PAYTO, "maxTimeoutSeconds": 60, "extra": {"name": "USDC"},
}


def _listing(url, description, network, asset, pay_to, amount):
    return {
        "url": url,
        "description": description,
        "accepts": [{"network": network, "asset": asset, "payTo": pay_to, "amount": amount}],
    }


def _algo(url, amount):
    return _listing(url, NEED, ALGO_NET, ALGO_USDC, ALGO_PAYTO, amount)


def _base(url, amount):
    return _listing(url, NEED, payment.BASE_CAIP2, payment.USDC_BASE, BASE_PAYTO, amount)


class PriceBoundRankingTests(unittest.TestCase):
    """A6: prefer_network=algorand with max_price_usd=0.003 missed as probe_limit_reached while
    94 cheaper candidates, including Base at $0.002, were never probed."""

    def test_price_bound_is_the_tightest_known_bound(self):
        self.assertIsNone(probe.price_bound_usd({}))
        self.assertIsNone(probe.price_bound_usd(None))
        self.assertEqual(probe.price_bound_usd({"max_price_usd": 0.05}), 0.05)
        self.assertEqual(probe.price_bound_usd({"max_price_usd": 0.05, "max_amount_atomic": 3000}), 0.003)
        self.assertEqual(probe.price_bound_usd({"max_total_cost_usd": 0.01, "max_price_usd": "bad"}), 0.01)
        self.assertIsNone(probe.price_bound_usd({"max_price_usd": True}))

    def test_claimed_price_reads_the_listing_and_respects_a_lock(self):
        listing = _base("https://c.example/wallet-balance", "2000")
        self.assertEqual(probe.claimed_min_usd(listing), 0.002)
        self.assertIsNone(probe.claimed_min_usd(listing, rails=frozenset({"algorand"})))
        self.assertIsNone(probe.claimed_min_usd({"url": "https://d.example/x", "accepts": []}))
        self.assertIsNone(probe.claimed_min_usd({"url": "https://d.example/x"}))

    def test_priced_out_preferred_listings_rank_after_the_ones_that_fit(self):
        algo_a = _algo("https://a.example/wallet-balance", "100000")
        algo_b = _algo("https://b.example/wallet-balance", "50000")
        base = _base("https://c.example/wallet-balance", "2000")
        items = [algo_a, algo_b, base]
        plain = [probe._resource_url(i) for i in probe.rank_resources(NEED, items, prefer_network="algorand")]
        self.assertEqual(plain[-1], "https://c.example/wallet-balance")
        bounded = probe.rank_resources(NEED, items, prefer_network="algorand", price_bound=0.003)
        self.assertEqual(probe._resource_url(bounded[0]), "https://c.example/wallet-balance")
        # The preference still leads among listings that fit the bound.
        cheap_algo = _algo("https://e.example/wallet-balance", "2500")
        with_fit = probe.rank_resources(NEED, items + [cheap_algo], prefer_network="algorand", price_bound=0.003)
        self.assertEqual(probe._resource_url(with_fit[0]), "https://e.example/wallet-balance")
        self.assertEqual(probe._resource_url(with_fit[1]), "https://c.example/wallet-balance")
        # Unknown prices keep their place: the probe decides, not the claim.
        unknown = {"url": "https://f.example/wallet-balance", "description": NEED, "accepts": [{"network": ALGO_NET, "payTo": ALGO_PAYTO}]}
        keep = probe.rank_resources(NEED, [algo_a, unknown, base], prefer_network="algorand", price_bound=0.003)
        self.assertEqual([probe._resource_url(i) for i in keep][:2], ["https://f.example/wallet-balance", "https://c.example/wallet-balance"])

    def test_partition_is_stable_and_a_lock_narrows_the_claim(self):
        algo = _algo("https://a.example/wallet-balance", "100000")
        base = _base("https://c.example/wallet-balance", "2000")
        self.assertEqual(probe.priced_out_last([algo, base], None), [algo, base])
        self.assertEqual(probe.priced_out_last([algo, base], 0.003), [base, algo])
        # Under a Solana lock the Algorand claim is not on a locked rail, so it is unknown and keeps its place.
        self.assertEqual(probe.priced_out_last([algo, base], 0.003, rails=frozenset({"solana"})), [algo, base])


class OwnOriginTests(unittest.TestCase):
    """First run, Solana lock: the only candidate was 402signal.com/route, probed and refused."""

    def test_own_hosts_are_never_candidates(self):
        for url in ("https://402signal.com/route", "https://www.402signal.com/route", "https://402signal.com/"):
            self.assertTrue(probe.skip_candidate_url(url), url)
        self.assertFalse(probe.skip_candidate_url("https://api.syraa.fun/news"))
        ranked = probe.rank_resources("news headlines", [
            _listing("https://402signal.com/route", "news headlines check", payment.SOLANA_MAINNET, payment.USDC_SOLANA_MINT, SOL_PAYTO, "3000"),
            _listing("https://api.syraa.fun/news", "news headlines", payment.SOLANA_MAINNET, payment.USDC_SOLANA_MINT, SOL_PAYTO, "1000"),
        ])
        self.assertEqual([probe._resource_url(i) for i in ranked], ["https://api.syraa.fun/news"])


class LockAlignmentTests(unittest.TestCase):
    """B2: a Solana-locked check of a seller whose first accept is Base selected the Solana
    option but kept the Base recipient at top level, failed the billable-winner gate and
    was answered as an unbilled no_402_envelope 503."""

    def _result(self):
        env = {
            "x402Version": 2, "error": "PAYMENT-SIGNATURE header is required",
            "resource": {"url": URL, "mimeType": "application/json"},
            "accepts": [dict(BASE_ACCEPT), dict(SOL_ACCEPT)],
        }
        return {
            "live": True, "url": URL, "status": 402, "latency_ms": 131, "has_402_challenge": True,
            "payTo": BASE_PAYTO, "rail": "base", "amount": "8000", "envelope": env,
            "payable": True, "invocable": False, "challenge_observed": True,
            "target": {"accepts": [dict(BASE_ACCEPT), dict(SOL_ACCEPT)], "amountAtomic": "8000", "displayAmount": "$0.008"},
        }

    def test_solana_lock_on_a_base_first_seller_is_billable_once_aligned(self):
        body = {"need": "search", "networks": ["solana"]}
        cons = policy.merge_constraints(body)
        result = self._result()
        selected = select.pick_selected_payment(result, None, cons)
        self.assertIsNotNone(selected)
        self.assertEqual(selected["rail"], "solana")
        self.assertEqual(selected["payTo"], SOL_PAYTO)
        result["selected_payment"] = selected
        self.assertFalse(route._billable_winner(body, 200, dict(result)))
        probe._align_target_with_selected(result, selected)
        self.assertEqual((result["payTo"], result["rail"], result["amount"]), (SOL_PAYTO, "solana", "8000"))
        self.assertEqual(result["target"]["amountAtomic"], "8000")
        self.assertTrue(route._billable_winner(body, 200, result))

    def test_alignment_without_a_lock_keeps_the_first_accept(self):
        body = {"need": "search"}
        cons = policy.merge_constraints(body)
        result = self._result()
        selected = select.pick_selected_payment(result, None, cons)
        self.assertEqual(selected["rail"], "base")
        result["selected_payment"] = selected
        probe._align_target_with_selected(result, selected)
        self.assertEqual((result["payTo"], result["rail"]), (BASE_PAYTO, "base"))
        self.assertTrue(route._billable_winner(body, 200, result))
        probe._align_target_with_selected(result, None)
        probe._align_target_with_selected("not a dict", selected)


if __name__ == "__main__":
    unittest.main()
