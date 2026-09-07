"""Published response examples must satisfy runtime decision invariants."""
import copy
import unittest

from live402 import discover, payment
from live402.route import _billable_winner
from live402.route_outcomes import is_normal_miss


class DocumentedRouteContractTests(unittest.TestCase):
    def setUp(self):
        self.spec = discover.openapi_spec()
        self.examples = self.spec["paths"]["/route"]["post"]["responses"]["200"]["content"]["application/json"]["examples"]

    def test_settled_example_passes_the_real_winner_gate(self):
        winner = self.examples["settled_winner"]["value"]
        request = {"url": winner["url"], "networks": ["base"], "max_price_usd": 0.01}
        self.assertTrue(_billable_winner(request, 200, winner))
        self.assertEqual(winner["billing"]["amount_atomic"], payment.AMOUNT_ATOMIC)
        self.assertEqual(winner["selected_payment"]["amount_atomic"], 10000)
        self.assertTrue(winner["billing"]["settled"])
        self.assertEqual(winner["target"]["accepts"], winner["envelope"]["accepts"])
        self.assertEqual(winner["target"]["method"], winner["probes"][0]["method"])
        changed = copy.deepcopy(winner)
        changed["envelope"]["accepts"][0]["payTo"] = "0x2222222222222222222222222222222222222222"
        self.assertFalse(_billable_winner(request, 200, changed))

    def test_completed_miss_example_is_explicitly_unpaid_and_never_billable(self):
        miss = self.examples["normal_typed_miss"]["value"]
        self.assertTrue(is_normal_miss(miss))
        self.assertFalse(_billable_winner({}, 200, miss))
        self.assertIs(miss["billing"]["settled"], False)
        self.assertIs(miss["billing"]["settlement_attempted"], False)
        self.assertEqual(miss["billing"]["settlement_state"], "not_attempted")


if __name__ == "__main__":
    unittest.main()
