"""Self-serve usage for the two customer credentials. Read-only, caller-scoped.

`GET /keys/usage` answers for exactly the credentials the caller presents:

- `X-402Signal-Trial`: a check credit (hashed token in the session store):
  remaining, used, ceiling and expiry.
- `X-402Signal-Key`: an admission key from the operator policy: whether it is
  recognized and the ingress and unpaid capacities it carries.

Nothing about other tokens, no listing, no minting. Unknown or malformed
credentials read as `recognized: false`, not as an error, so a probe cannot
distinguish "never issued" from "expired" by status code.
"""
from __future__ import annotations

import datetime
import time


def _iso(ts) -> str | None:
    try:
        return datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def credits_usage(headers) -> dict:
    from live402 import session

    token = session.trial_token(headers)
    if not token:
        return {"presented": False}
    digest = session._hash_secret(token)
    now = int(time.time())
    with session._lock:
        row = session._trial_row(session._connect().cursor(), digest)
    if not row:
        return {"presented": True, "recognized": False}
    expires_at, used, ceiling = (int(v) for v in row)
    active = expires_at >= now
    return {
        "presented": True,
        "recognized": True,
        "active": active,
        "remaining": max(0, ceiling - used) if active else 0,
        "used": used,
        "ceiling": ceiling,
        "expires_at": _iso(expires_at),
        "scope": "listed URLs, no facilitator settlement, sponsored traffic class",
    }


def key_usage(headers, peer) -> dict:
    from live402 import admission

    values = [v for k, v in dict(headers or {}).items() if str(k).lower() == "x-402signal-key"]
    if hasattr(headers, "get_all"):
        values = list(headers.get_all("X-402Signal-Key", []))
    if not values:
        return {"presented": False}
    if len(values) != 1 or not admission.configured():
        return {"presented": True, "recognized": False}
    identity, customer = admission.engine().identity(headers, peer)
    if not customer:
        return {"presented": True, "recognized": False}
    return {
        "presented": True,
        "recognized": True,
        "capacity": {"ingress": customer.get("ingress"), "unpaid": customer.get("unpaid")},
        "window_seconds": admission.engine().policy.window,
        "identity_prefix": identity.split(":", 1)[1][:12],
    }


def usage(headers, peer) -> dict:
    return {
        "credits": credits_usage(headers),
        "key": key_usage(headers, peer),
        "how_to_get_credits": "ross@402signal.com, subject \"check credits\"",
    }
