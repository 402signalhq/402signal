"""Operator wallets that pay for checks of real sellers.

`LIVE402_SELF_PAYERS` is a comma-separated list of payer addresses on any fee
rail (EVM addresses compare case-insensitively). A settled check whose verified
payer is on the list keeps its probe rows organic, because the seller facts it
observed are real, but its settled and qualified counters and its payer day are
filed under the traffic label "self", so the north star, the organic rollup and
the monthly report never count the operator as a customer.

The list is read per call: it changes only with a secret rotation and restart,
and reading it is cheap.
"""

from __future__ import annotations

import os

LABEL = "self"
ENV = "LIVE402_SELF_PAYERS"


def _norm(value) -> str:
    text = str(value or "").strip()
    return text.lower() if text[:2].lower() == "0x" else text


def configured() -> frozenset:
    raw = os.environ.get(ENV, "")
    return frozenset(_norm(part) for part in raw.split(",") if part.strip())


def is_self(payer) -> bool:
    """True when the verified payer is one of the operator's own wallets."""
    if not payer:
        return False
    return _norm(payer) in configured()
