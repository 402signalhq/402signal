"""PayAI merchant JWTs. Credentials stay in process; no network or payment retry.

Protocol: https://docs.payai.network/x402/facilitators/authentication
The cache holds one token per process, renewed before expiry. A merchant API
signing key is provider authentication material, never a buyer/seller wallet key.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
import hashlib
import json
import math
import os
import re
import threading
import time
import uuid

TOKEN_TTL_SECONDS = 120
REFRESH_MARGIN_SECONDS = 30
_TARGETS = frozenset({
    ("POST", "https://facilitator.payai.network/verify"),
    ("POST", "https://facilitator.payai.network/settle"),
    ("GET", "https://facilitator.payai.network/supported"),
})
_LOCK = threading.Lock()


@dataclass(frozen=True)
class _CachedToken:
    fingerprint: bytes = field(repr=False)
    token: str = field(repr=False)
    issued_at: int
    monotonic_at: float


_cache: _CachedToken | None = None


def _env(name: str, limit: int) -> str:
    raw = os.environ.get(name, "")
    if len(raw) > limit:
        raise ValueError("invalid PayAI authentication configuration")
    return raw.strip()


def _bearer(value: str) -> dict[str, str]:
    if value.startswith("payai_sk_") or not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", value):
        raise ValueError("invalid PayAI authentication configuration")
    return {"Authorization": "Bearer " + value}


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _mint(kid: str, secret: str, now: int) -> str:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import load_der_private_key

    der = base64.b64decode(secret, validate=True)
    if not der or len(der) > 1024:
        raise ValueError("invalid PayAI authentication configuration")
    key = load_der_private_key(der, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("invalid PayAI authentication configuration")
    header = {"alg": "EdDSA", "typ": "JWT", "kid": kid}
    claims = {"sub": kid, "iss": "payai-merchant", "iat": now,
              "exp": now + TOKEN_TTL_SECONDS, "jti": str(uuid.uuid4())}
    message = ".".join(_b64url(json.dumps(value, separators=(",", ":")).encode("utf-8"))
                       for value in (header, claims))
    return message + "." + _b64url(key.sign(message.encode("ascii")))


def headers_for(method: str, url: str) -> dict[str, str] | None:
    """Return headers, {} for unconfigured free tier, or None on invalid config.

    Precedence: explicit PAYAI_ACCESS_TOKEN; ID+SECRET JWT credentials; legacy
    PAYAI_API_KEY bearer. A partial/invalid key pair never falls back to anonymous
    or a legacy token. Static bearer expiry/rotation remains operator-managed.
    No credential is returned for another host, endpoint, method or redirect.
    """
    global _cache
    if type(method) is not str or type(url) is not str or (method.upper(), url) not in _TARGETS:
        return None
    with _LOCK:
        try:
            explicit = _env("PAYAI_ACCESS_TOKEN", 8192)
            if explicit:
                _cache = None
                return _bearer(explicit)
            kid = _env("PAYAI_API_KEY_ID", 256)
            secret = _env("PAYAI_API_KEY_SECRET", 4096)
            if not kid and not secret:
                _cache = None
                legacy = _env("PAYAI_API_KEY", 8192)
                return _bearer(legacy) if legacy else {}
            if not kid or not secret or not re.fullmatch(r"[\x21-\x7e]{1,256}", kid):
                raise ValueError("invalid PayAI authentication configuration")
            secret = secret.removeprefix("payai_sk_")
            fingerprint = hashlib.sha256(json.dumps([kid, secret], separators=(",", ":")).encode()).digest()
            wall, mono = time.time(), time.monotonic()
            if not math.isfinite(wall) or not math.isfinite(mono) or wall < 0 or wall > 2**53 - TOKEN_TTL_SECONDS or mono < 0:
                raise ValueError("invalid authentication clock")
            now = int(wall)
            lifetime = TOKEN_TTL_SECONDS - REFRESH_MARGIN_SECONDS
            cached = _cache
            if (cached is not None and cached.fingerprint == fingerprint
                    and cached.issued_at <= now < cached.issued_at + lifetime
                    and 0 <= mono - cached.monotonic_at < lifetime):
                return {"Authorization": "Bearer " + cached.token}
            # Clear old material before minting: changed/invalid credentials must
            # never get a previously cached token on a parse or signing failure.
            _cache = None
            token = _mint(kid, secret, now)
            _cache = _CachedToken(fingerprint, token, now, mono)
            return {"Authorization": "Bearer " + token}
        except Exception:
            # Provider credentials, DER parser errors and tokens never enter logs
            # or public error responses. There is no network fallback or retry.
            _cache = None
            return None
