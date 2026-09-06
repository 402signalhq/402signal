import copy
from datetime import date
import unittest
from scripts.infrastructure_budget import BudgetError, CATEGORIES, check

TODAY=date(2026,9,6)


def inventory():
    return dict(version=1,currency='USD',all_services_accounted_for=True,
                monthly_limit_usd='100',contingency_usd='20',services=[
        dict(name='Tatum' if category == 'rpc' else category,category=category,
             verified=True,auto_upgrade_disabled=True,evidence='synthetic unit-test evidence only',
             verified_on=TODAY.isoformat(),usage_taxes_storage_egress_included=True,monthly_max_usd='5')
        for category in sorted(CATEGORIES)])


class BudgetContracts(unittest.TestCase):
    def test_all_services_plus_contingency(self):
        result=check(inventory(),TODAY)
        self.assertEqual(result['headroom_usd'],'40')
        self.assertFalse(result['cloud_billing_cap_enforced'])

    def test_unknown_current_bills_cannot_authorize_new_spend(self):
        doc=inventory();doc['all_services_accounted_for']=False
        with self.assertRaises(BudgetError):check(doc,TODAY)
        doc=inventory();doc['services'][0]['verified']=False
        with self.assertRaises(BudgetError):check(doc,TODAY)

    def test_over_budget_and_limit_increase_rejected(self):
        doc=inventory();doc['services'][0]['monthly_max_usd']='99'
        with self.assertRaises(BudgetError):check(doc,TODAY)
        doc=inventory();doc['monthly_limit_usd']='101'
        with self.assertRaises(BudgetError):check(doc,TODAY)

    def test_invalid_values_cannot_bypass_budget(self):
        for value in (None,True,1.5,'NaN','Infinity','-1'):
            doc=inventory();doc['services'][0]['monthly_max_usd']=value
            with self.assertRaises(BudgetError):check(doc,TODAY)

    def test_automatic_upgrades_rejected(self):
        doc=inventory();doc['services'][0]['auto_upgrade_disabled']=False
        with self.assertRaises(BudgetError):check(doc,TODAY)

    def test_separate_signer_and_tatum_cannot_be_omitted(self):
        for category in ('signer','rpc'):
            doc=inventory();doc['services']=[x for x in doc['services'] if x['category'] != category]
            with self.assertRaises(BudgetError):check(doc,TODAY)

    def test_unbounded_variable_costs_rejected(self):
        doc=inventory();doc['services'][0]['usage_taxes_storage_egress_included']=False
        with self.assertRaises(BudgetError):check(doc,TODAY)

    def test_stale_or_future_verification_rejected(self):
        for value in ('2026-08-01','2026-09-07'):
            doc=inventory();doc['services'][0]['verified_on']=value
            with self.assertRaises(BudgetError):check(doc,TODAY)
