"""Validate an operator-verified all-services budget. This is NOT a cloud billing cap.

Unknown bills fail closed. No provider accounts are created, changed, or queried.
Provider-side limits and disabled automatic upgrades must be evidenced separately.
"""
from __future__ import annotations
import argparse
from datetime import date
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path

CATEGORIES = {'router','signer','database','rpc','storage_backup','monitoring','network','other'}


class BudgetError(ValueError):
    pass


def money(value):
    if not isinstance(value, str) or len(value) > 30:
        raise BudgetError('monthly ceilings must be decimal strings')
    try:
        amount = Decimal(value)
        if not amount.is_finite() or amount < 0 or amount > 10000:
            raise BudgetError('invalid monthly ceiling')
        return amount
    except InvalidOperation:
        raise BudgetError('invalid monthly ceiling') from None


def check(document, today=None):
    today = today or date.today()
    if not isinstance(document, dict) or type(document.get('version')) is not int or document.get('version') != 1 or document.get('currency') != 'USD':
        raise BudgetError('unsupported budget record')
    if document.get('all_services_accounted_for') is not True:
        raise BudgetError('complete infrastructure inventory not verified')
    cap = money(document.get('monthly_limit_usd'))
    reserve = money(document.get('contingency_usd'))
    if cap > 100 or reserve < 10:
        raise BudgetError('budget must remain <=100 USD with >=10 USD contingency')
    entries = document.get('services')
    if not isinstance(entries, list) or not entries or len(entries) > 100:
        raise BudgetError('missing service inventory')
    categories, names, total = set(), set(), Decimal(0)
    for entry in entries:
        if not isinstance(entry, dict):
            raise BudgetError('invalid service entry')
        name, category = entry.get('name'), entry.get('category')
        if not isinstance(name, str) or not name.strip() or name in names or category not in CATEGORIES:
            raise BudgetError('invalid or duplicate service identity')
        if entry.get('verified') is not True or entry.get('auto_upgrade_disabled') is not True:
            raise BudgetError('unverified service cost or automatic-upgrade policy')
        if not isinstance(entry.get('evidence'), str) or not entry['evidence'].strip():
            raise BudgetError('missing billing/limit evidence')
        try:
            age = (today - date.fromisoformat(entry['verified_on'])).days
        except (KeyError, TypeError, ValueError):
            raise BudgetError('invalid verification date') from None
        if not 0 <= age <= 7:
            raise BudgetError('billing verification is stale')
        if entry.get('usage_taxes_storage_egress_included') is not True:
            raise BudgetError('variable costs are not bounded')
        total += money(entry.get('monthly_max_usd'))
        categories.add(category)
        names.add(name)
    if categories != CATEGORIES or 'Tatum' not in names:
        raise BudgetError('inventory must include all categories and Tatum explicitly')
    if total + reserve > cap:
        raise BudgetError('all-in infrastructure ceiling exceeded')
    return {'ok': True, 'monthly_max_usd': str(total), 'contingency_usd': str(reserve),
            'headroom_usd': str(cap-total-reserve), 'cloud_billing_cap_enforced': False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('inventory', type=Path)
    args = p.parse_args()
    try:
        # Limit local input size, reject non-standard JSON numbers.
        raw = args.inventory.read_bytes()
        if len(raw) > 65536:
            raise BudgetError('inventory too large')
        result = check(json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(BudgetError('invalid JSON number'))))
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, TypeError):
        print(json.dumps({'ok': False, 'error': 'infrastructure budget not verified'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
