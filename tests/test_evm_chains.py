"""Observed EVM chains beyond Base: classification, USDC normalization, locks. Fee rails unchanged."""

from __future__ import annotations

import json
import os
import unittest

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import evm_chains, payment, probe, schema_fields, select
from live402.select import ConstraintError

POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
SEI_USDC = "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392"
CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C"
ROBINHOOD_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
PAYTO = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca"


def accept(network, asset, amount="10000", pay_to=PAYTO, scheme="exact"):
    return {"scheme": scheme, "network": network, "asset": asset, "amount": amount,
            "payTo": pay_to, "maxTimeoutSeconds": 60}


def result_with(accepts):
    return {
        "live": True, "url": "https://seller.example/api",
        "envelope": {"x402Version": 2, "accepts": accepts},
        "target": {"accepts": accepts},
    }


class ChainTableTests(unittest.TestCase):
    def test_table_is_consistent_and_unique(self):
        rails = [chain[0] for chain in evm_chains.CHAINS]
        networks = [chain[1] for chain in evm_chains.CHAINS]
        self.assertEqual(len(set(rails)), len(rails))
        self.assertEqual(len(set(networks)), len(networks))
        self.assertNotIn("base", rails)
        for rail, network, name, usdc in evm_chains.CHAINS:
            self.assertRegex(network, r"^eip155:[1-9][0-9]*$")
            self.assertTrue(name)
            if usdc is not None:
                self.assertRegex(usdc, r"^0x[0-9a-fA-F]{40}$")
                self.assertTrue(payment._eip55_ok(usdc), rail)
        self.assertEqual(evm_chains.rail_of_network("eip155:137"), "polygon")
        self.assertEqual(evm_chains.rail_of_network("EIP155:42161"), "arbitrum")
        self.assertEqual(evm_chains.rail_of_network("world"), "worldchain")
        self.assertEqual(evm_chains.rail_of_network("bsc"), "bnb")
        self.assertIsNone(evm_chains.rail_of_network("eip155:8453"))
        self.assertIsNone(evm_chains.rail_of_network("eip155:31337"))
        self.assertEqual(evm_chains.rail_of_caip2("eip155:143"), "monad")
        self.assertIsNone(evm_chains.rail_of_caip2("EIP155:143"))
        self.assertIsNone(evm_chains.rail_of_caip2("monad"))
        self.assertEqual(evm_chains.network_of_rail("hyperevm"), "eip155:999")
        self.assertIsNone(evm_chains.usdc_of_rail("bnb"))
        self.assertEqual(evm_chains.rail_of_network("eip155:1329"), "sei")
        self.assertEqual(evm_chains.rail_of_network("sei-evm"), "sei")
        self.assertEqual(evm_chains.rail_of_network("celo"), "celo")
        self.assertEqual(evm_chains.rail_of_network("robinhood-chain"), "robinhood")
        self.assertEqual(evm_chains.rail_of_network("tempo"), "tempo")
        self.assertEqual(evm_chains.rail_of_caip2("eip155:42220"), "celo")
        self.assertEqual(evm_chains.rail_of_caip2("eip155:4663"), "robinhood")
        self.assertEqual(evm_chains.usdc_of_rail("sei"), SEI_USDC)
        self.assertEqual(evm_chains.usdc_of_rail("celo"), CELO_USDC)
        self.assertIsNone(evm_chains.usdc_of_rail("robinhood"))
        self.assertEqual(evm_chains.display_name("robinhood"), "Robinhood Chain")
        self.assertTrue(evm_chains.is_evm_rail("base"))
        self.assertTrue(evm_chains.is_evm_rail("xlayer"))
        self.assertFalse(evm_chains.is_evm_rail("solana"))

    def test_fee_rails_are_unchanged(self):
        self.assertEqual(payment.FEE_RAILS, frozenset({"base", "solana", "algorand"}))
        self.assertEqual(payment.SUPPORTED_RAILS, payment.FEE_RAILS)
        self.assertTrue(payment.FEE_RAILS < payment.OBSERVED_RAILS)
        self.assertIn("polygon", payment.OBSERVED_RAILS)
        self.assertNotIn("polygon", payment.SUPPORTED_RAILS)
        self.assertEqual(schema_fields.RAILS[:3], ("base", "solana", "algorand"))
        self.assertEqual(set(schema_fields.RAILS), payment.OBSERVED_RAILS)
        receipt = payment.sanitize_settlement_receipt(
            {"success": True, "network": "eip155:137", "transaction": "0x" + "ab" * 32}, "polygon")
        self.assertIsNone(receipt)
        receipt = payment.sanitize_settlement_receipt(
            {"success": True, "network": "eip155:8453", "transaction": "0x" + "ab" * 32}, "base")
        self.assertEqual(receipt["network"], "eip155:8453")


class PaymentOptionTests(unittest.TestCase):
    def test_rail_of_network_and_observed_network(self):
        self.assertEqual(payment.rail_of_network("eip155:137"), "polygon")
        self.assertEqual(payment.rail_of_network("polygon"), "polygon")
        self.assertEqual(payment.rail_of_network("eip155:8453"), "base")
        self.assertEqual(payment.rail_of_observed_network("eip155:42161", 2), "arbitrum")
        self.assertIsNone(payment.rail_of_observed_network("arbitrum", 2))
        self.assertEqual(payment.rail_of_observed_network("arbitrum", 1), "arbitrum")
        self.assertIsNone(payment.rail_of_observed_network("eip155:31337", 2))
        self.assertEqual(payment._rail_name("worldchain"), "worldchain")
        self.assertEqual(payment._rail_name("eip155:480"), "worldchain")

    def test_polygon_usdc_offer_is_normalized_to_dollars(self):
        opt = payment.payment_option_from_accept(accept("eip155:137", POLYGON_USDC))
        self.assertEqual((opt["rail"], opt["network"], opt["decimals"]), ("polygon", "eip155:137", 6))
        self.assertEqual((opt["display_amount"], opt["normalized_usd"]), ("$0.01", 0.01))
        self.assertTrue(payment.is_complete_payment_option(opt, {"x402Version": 2, "accepts": [accept("eip155:137", POLYGON_USDC)]}))
        self.assertEqual(payment.asset_identity(opt), "usdc:" + POLYGON_USDC.lower())
        self.assertEqual(payment.usdc_asset_for_rail("polygon"), POLYGON_USDC)

    def test_wrong_chain_usdc_and_unknown_assets_are_never_priced(self):
        opt = payment.payment_option_from_accept(accept("eip155:137", ARBITRUM_USDC))
        self.assertEqual(opt["rail"], "polygon")
        self.assertIsNone(opt["normalized_usd"])
        self.assertEqual(opt["display_amount"], "10000 " + ARBITRUM_USDC)
        self.assertTrue(payment.is_complete_payment_option(opt))
        self.assertEqual(payment.asset_identity(opt), "polygon:" + ARBITRUM_USDC.lower())
        bnb = payment.payment_option_from_accept(accept("eip155:56", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", amount="10000000000000000"))
        self.assertEqual(bnb["rail"], "bnb")
        self.assertIsNone(bnb["normalized_usd"])
        self.assertFalse(payment.known_usdc_asset(POLYGON_USDC, "eip155:42161"))
        self.assertTrue(payment.known_usdc_asset(POLYGON_USDC, "eip155:137"))
        self.assertTrue(payment.known_usdc_asset(POLYGON_USDC))
        self.assertTrue(payment.known_usdc_asset(payment.USDC_BASE, "base"))

    def test_evm_recipients_and_assets_validate_like_base(self):
        self.assertTrue(payment.valid_payto_for_rail(PAYTO, "arbitrum"))
        self.assertFalse(payment.valid_payto_for_rail("C8qDYG8NTyvdY85gvGfs1WajwGhiLu6f1vi3JaG1r1iA", "arbitrum"))
        self.assertTrue(payment.valid_asset_for_rail(ARBITRUM_USDC, "arbitrum"))
        self.assertFalse(payment.valid_asset_for_rail("31566704", "arbitrum"))
        self.assertTrue(payment.payto_equal(PAYTO, PAYTO.upper().replace("0X", "0x"), "monad"))
        self.assertEqual(payment.payto_canonical(PAYTO.upper().replace("0X", "0x"), "monad"), PAYTO)

    def test_sei_and_celo_usdc_are_priced_and_robinhood_usdg_is_not(self):
        for network, rail, usdc in (("eip155:1329", "sei", SEI_USDC), ("eip155:42220", "celo", CELO_USDC)):
            opt = payment.payment_option_from_accept(accept(network, usdc))
            self.assertEqual((opt["rail"], opt["network"], opt["decimals"]), (rail, network, 6))
            self.assertEqual((opt["display_amount"], opt["normalized_usd"]), ("$0.01", 0.01))
            self.assertTrue(payment.is_complete_payment_option(opt))
            self.assertEqual(payment.asset_identity(opt), "usdc:" + usdc.lower())
            self.assertTrue(payment.known_usdc_asset(usdc, network))
            self.assertEqual(payment.usdc_asset_for_rail(rail), usdc)
        # Robinhood Chain pays in Paxos USDG: classified and selectable, never priced.
        usdg = payment.payment_option_from_accept(accept("eip155:4663", ROBINHOOD_USDG))
        self.assertEqual((usdg["rail"], usdg["network"]), ("robinhood", "eip155:4663"))
        self.assertIsNone(usdg["normalized_usd"])
        self.assertEqual(usdg["display_amount"], "10000 " + ROBINHOOD_USDG)
        self.assertTrue(payment.is_complete_payment_option(usdg))
        self.assertEqual(payment.asset_identity(usdg), "robinhood:" + ROBINHOOD_USDG.lower())
        self.assertFalse(payment.known_usdc_asset(ROBINHOOD_USDG, "eip155:4663"))
        self.assertIsNone(payment.usdc_asset_for_rail("robinhood"))
        self.assertTrue(payment.valid_payto_for_rail(PAYTO, "robinhood"))
        cons = select.parse_constraints({"need": "weather", "networks": ["sei", "eip155:42220", "robinhood"]})
        self.assertEqual(cons["rails"], frozenset({"sei", "celo", "robinhood"}))

    def test_unlisted_evm_chain_stays_unclassified(self):
        opt = payment.payment_option_from_accept(accept("eip155:31337", POLYGON_USDC))
        self.assertIsNone(opt["rail"])
        self.assertFalse(payment.is_complete_payment_option(opt))


class SelectionTests(unittest.TestCase):
    def test_networks_lock_accepts_rail_names_and_caip2_ids(self):
        cons = select.parse_constraints({"need": "weather", "networks": ["polygon", "eip155:42161"]})
        self.assertEqual(cons["rails"], frozenset({"polygon", "arbitrum"}))
        select.validate_explicit_constraints({"need": "weather", "networks": ["eip155:137"], "prefer_network": "eip155:480"})
        with self.assertRaises(ConstraintError):
            select.validate_explicit_constraints({"need": "weather", "networks": ["eip155:31337"]})
        with self.assertRaises(ConstraintError):
            select.validate_explicit_constraints({"need": "weather", "prefer_network": "tron"})

    def test_polygon_winner_satisfies_a_polygon_lock_and_fails_a_base_lock(self):
        result = result_with([accept("eip155:137", POLYGON_USDC)])
        result["selected_payment"] = payment.payment_option_from_accept(accept("eip155:137", POLYGON_USDC))
        result["payable"] = True
        polygon = select.parse_constraints({"networks": ["polygon"]})
        base = select.parse_constraints({"networks": ["base"]})
        self.assertTrue(select.selected_payment_matches_networks(result["selected_payment"], polygon))
        self.assertFalse(select.selected_payment_matches_networks(result["selected_payment"], base))
        self.assertEqual(select._result_rails(result), {"polygon"})

    def test_probe_classifies_listings_by_exact_network(self):
        self.assertEqual(probe._item_rail({"accepts": [accept("eip155:42161", ARBITRUM_USDC)]}), "arbitrum")
        self.assertEqual(probe._item_rail({"accepts": [accept("eip155:8453", payment.USDC_BASE)]}), "base")
        self.assertEqual(probe._item_rail({"accepts": [{"network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}]}), "solana")
        self.assertEqual(probe._item_rail({"accepts": [{"network": "eip155:31337"}]}), "unknown")
        self.assertEqual(probe.normalize_prefer_network("eip155:137"), "polygon")
        self.assertEqual(probe.normalize_networks(["polygon", "base", "polygon"]), ("base", "polygon"))
        self.assertEqual(probe.PREFER_NETWORKS[:3], ("base", "solana", "algorand"))

    def test_mcp_and_http_schemas_advertise_the_observed_networks(self):
        from live402 import mcp

        enum = mcp.INPUT_SCHEMA["properties"]["prefer_network"]["enum"]
        self.assertEqual(enum[:3], ["base", "solana", "algorand"])
        self.assertIn("polygon", enum)
        self.assertIn("hyperevm", enum)
        for rail in ("tempo", "sei", "celo", "robinhood"):
            self.assertIn(rail, enum)
            self.assertIn(rail, schema_fields.PREFER_NETWORK_DESC)
        self.assertIn("eip155:137", json.dumps(mcp.INPUT_SCHEMA))


if __name__ == "__main__":
    unittest.main()
