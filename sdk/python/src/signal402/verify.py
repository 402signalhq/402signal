"""Offline verification of a 402Signal transparency receipt.

A paid check answer carries ``pq_trust.transparency`` with a private ``reveal``
and a public ``receipt``. This module recomputes, with nothing but the caller's
pinned log key:

1. the v4/v5 commitment from the reveal (SHA-256 over a domain tag, the RFC
   8785 canonical evidence and the salt);
2. the public leaf bytes (RFC 8785 JSON of type, ts, nonce, commitment) and its
   RFC 6962 leaf hash, which must equal ``receipt.leaf_hash``;
3. the RFC 6962 inclusion path from that leaf to the checkpoint root;
4. the C2SP signed-note checkpoint's Ed25519 signature from the pinned key,
   whose name must equal the checkpoint origin.

It mirrors ``live402.pq.receipt.verify_route_receipt`` on the server, and the
conformance fixture in ``tests/fixtures/route-binding-v1.json`` pins both.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

SIG_ED25519 = 0x01
HASH_SIZE = 32
EMDASH = "—"
NOTE_LINE = re.compile(r"^" + EMDASH + r" (\S+) (\S+)$")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
TYPE_V4 = "402signal.route_decision.v4"
TYPE_V5 = "402signal.route_decision.v5"
DOMAINS = {TYPE_V4: b"402signal.route_decision.v4\0", TYPE_V5: b"402signal.route_decision.v5\0"}
REVEAL_KEYS = frozenset({"type", "ts", "nonce", "commitment", "event_version", "evidence", "salt"})


class ReceiptError(ValueError):
    """Any verification failure. Messages are constant; they never echo evidence."""


# --- RFC 8785 canonical JSON (subset: safe integers, finite floats) ---------

def _has_lone_surrogate(text: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)


def _serialize(obj: Any) -> str:
    if obj is None:
        return "null"
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if isinstance(obj, str):
        if _has_lone_surrogate(obj):
            raise ReceiptError("invalid evidence")
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    if isinstance(obj, int):
        if abs(obj) > 2**53 - 1:
            raise ReceiptError("invalid evidence")
        return str(int(obj))
    if isinstance(obj, float):
        if not math.isfinite(obj):
            raise ReceiptError("invalid evidence")
        if obj == 0:
            return "0"
        if obj.is_integer() and abs(obj) < 1e21:
            return str(int(obj))
        return json.dumps(obj, ensure_ascii=True)
    if isinstance(obj, list):
        return "[" + ",".join(_serialize(x) for x in obj) + "]"
    if isinstance(obj, dict):
        for key in obj:
            if not isinstance(key, str) or _has_lone_surrogate(key):
                raise ReceiptError("invalid evidence")
        return "{" + ",".join(
            _serialize(k) + ":" + _serialize(obj[k]) for k in sorted(obj.keys(), key=lambda k: k.encode("utf-16-be"))
        ) + "}"
    raise ReceiptError("invalid evidence")


def canonical(obj: Any) -> bytes:
    return _serialize(obj).encode("utf-8")


# --- RFC 6962 Merkle inclusion ---------------------------------------------

def leaf_hash(entry: bytes) -> bytes:
    return hashlib.sha256(b"\x00" + bytes(entry)).digest()


def node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + left + right).digest()


def _largest_power_of_two_less_than(n: int) -> int:
    k = 1
    while (k << 1) < n:
        k <<= 1
    return k


def root_from_inclusion(index: int, tree_size: int, leaf: bytes, path: list[bytes]) -> bytes:
    if tree_size < 1 or index < 0 or index >= tree_size:
        raise ValueError("index out of range")

    def fold(m: int, n: int, leftover: list[bytes]) -> bytes:
        if n == 1:
            if leftover:
                raise ValueError("path too long")
            return bytes(leaf)
        k = _largest_power_of_two_less_than(n)
        if not leftover:
            raise ValueError("path too short")
        sib = leftover.pop()
        if len(sib) != HASH_SIZE:
            raise ValueError("corrupt sibling")
        if m < k:
            return node_hash(fold(m, k, leftover), sib)
        return node_hash(sib, fold(m - k, n - k, leftover))

    return fold(index, tree_size, list(path))


def verify_inclusion(index: int, leaf: bytes, path: list[bytes], root: bytes, tree_size: int) -> bool:
    try:
        if len(leaf) != HASH_SIZE or len(root) != HASH_SIZE:
            return False
        return root_from_inclusion(index, tree_size, leaf, path) == bytes(root)
    except (TypeError, ValueError, IndexError):
        return False


# --- C2SP signed note + tlog checkpoint ------------------------------------

def _key_id(name: str, sig_type: int, public_key: bytes) -> bytes:
    return hashlib.sha256(name.encode("utf-8") + b"\n" + bytes([sig_type]) + public_key).digest()[:4]


def vkey_parse(text: str) -> dict:
    raw = (text or "").strip()
    first = raw.find("+")
    second = raw.find("+", first + 1) if first >= 0 else -1
    if first < 1 or second < 0 or second + 1 >= len(raw):
        raise ReceiptError("invalid vkey")
    name, kid_hex, blob_b64 = raw[:first], raw[first + 1:second], raw[second + 1:]
    try:
        kid = bytes.fromhex(kid_hex)
        blob = base64.b64decode(blob_b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise ReceiptError("invalid vkey") from exc
    if len(kid) != 4 or len(blob) != 33 or blob[0] != SIG_ED25519:
        raise ReceiptError("invalid vkey")
    public_key = blob[1:]
    if _key_id(name, SIG_ED25519, public_key) != kid:
        raise ReceiptError("invalid vkey")
    return {"name": name, "key_id": kid, "public_key": public_key}


def _parse_signed_note(note: str) -> tuple[str, list[dict]]:
    if not isinstance(note, str) or "\x00" in note or EMDASH + " " not in note:
        raise ReceiptError("invalid checkpoint")
    parts = (note if note.endswith("\n") else note + "\n").split("\n")
    blank = None
    for i, line in enumerate(parts[:-1]):
        if line == "":
            blank = i
    if blank is None or blank == 0:
        raise ReceiptError("invalid checkpoint")
    text = "\n".join(parts[:blank]) + "\n"
    sigs = []
    for line in parts[blank + 1:]:
        if line == "":
            continue
        m = NOTE_LINE.match(line)
        if not m:
            raise ReceiptError("invalid checkpoint")
        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except (ValueError, TypeError) as exc:
            raise ReceiptError("invalid checkpoint") from exc
        if len(raw) < 4 + 64:
            raise ReceiptError("invalid checkpoint")
        sigs.append({"name": m.group(1), "key_id": raw[:4], "payload": raw[4:]})
    if not sigs:
        raise ReceiptError("invalid checkpoint")
    return text, sigs


def _parse_checkpoint_body(text: str) -> dict:
    lines = (text if text.endswith("\n") else text + "\n").split("\n")
    if len(lines) < 4:
        raise ReceiptError("invalid checkpoint")
    origin, size_s, hash_s = lines[0], lines[1], lines[2]
    if not origin or not size_s.isdigit() or (size_s.startswith("0") and size_s != "0"):
        raise ReceiptError("invalid checkpoint")
    try:
        root = base64.b64decode(hash_s, validate=True)
    except (ValueError, TypeError) as exc:
        raise ReceiptError("invalid checkpoint") from exc
    if len(root) != HASH_SIZE:
        raise ReceiptError("invalid checkpoint")
    return {"origin": origin, "tree_size": int(size_s), "root": root}


def verify_checkpoint(note: str, trusted_log_vkey: str) -> dict:
    """Verify the checkpoint's Ed25519 signature from the pinned key. Returns origin, tree_size, root."""
    key = vkey_parse(trusted_log_vkey)
    text, sigs = _parse_signed_note(note)
    for sig in sigs:
        if sig["name"] != key["name"] or sig["key_id"] != key["key_id"]:
            continue
        if len(sig["payload"]) != 64:
            raise ReceiptError("invalid checkpoint")
        try:
            Ed25519PublicKey.from_public_bytes(key["public_key"]).verify(sig["payload"], text.encode("utf-8"))
        except InvalidSignature as exc:
            raise ReceiptError("checkpoint signature failed") from exc
        body = _parse_checkpoint_body(text)
        if body["origin"] != key["name"]:
            raise ReceiptError("untrusted log origin")
        return body
    raise ReceiptError("no signature from the trusted log key")


# --- Receipts ---------------------------------------------------------------

def verify_receipt(receipt: dict, trusted_log_vkey: str) -> dict:
    """Checkpoint signature plus inclusion of ``receipt.leaf_hash`` at ``receipt.index``."""
    if not isinstance(receipt, dict):
        raise ReceiptError("invalid receipt")
    body = verify_checkpoint(receipt.get("checkpoint") or "", trusted_log_vkey)
    index = receipt.get("index")
    if type(index) is not int:
        raise ReceiptError("invalid receipt index")
    path_b64 = receipt.get("inclusion_path")
    if not isinstance(path_b64, list):
        raise ReceiptError("corrupt inclusion path")
    try:
        path = [base64.b64decode(p, validate=True) for p in path_b64]
    except (TypeError, ValueError) as exc:
        raise ReceiptError("corrupt inclusion path") from exc
    leaf_hex = receipt.get("leaf_hash")
    if not isinstance(leaf_hex, str) or not HEX64.fullmatch(leaf_hex.lower()):
        raise ReceiptError("corrupt leaf hash")
    if not verify_inclusion(index, bytes.fromhex(leaf_hex), path, body["root"], body["tree_size"]):
        raise ReceiptError("corrupt proof")
    return {
        "origin": body["origin"],
        "tree_size": body["tree_size"],
        "root": body["root"].hex(),
        "index": index,
        "leaf_hash": leaf_hex.lower(),
    }


def verify_reveal(reveal: dict) -> str:
    """Recompute the public commitment from the private reveal. Returns the event type."""
    if not isinstance(reveal, dict) or set(reveal) != REVEAL_KEYS:
        raise ReceiptError("invalid reveal")
    version = reveal["event_version"]
    if version not in DOMAINS or reveal["type"] != version:
        raise ReceiptError("unsupported event version")
    commitment = reveal["commitment"]
    salt = reveal["salt"]
    if not isinstance(commitment, str) or not HEX64.fullmatch(commitment):
        raise ReceiptError("invalid reveal")
    if not isinstance(salt, str) or not HEX64.fullmatch(salt):
        raise ReceiptError("invalid reveal")
    if not isinstance(reveal["evidence"], dict):
        raise ReceiptError("invalid reveal")
    recomputed = hashlib.sha256(DOMAINS[version] + canonical(reveal["evidence"]) + bytes.fromhex(salt)).hexdigest()
    if recomputed != commitment:
        raise ReceiptError("reveal mismatch")
    return version


def verify_route_receipt(response: dict, trusted_log_vkey: str) -> dict:
    """Full offline check of a retained paid answer: reveal, leaf, inclusion, signature, origin."""
    if not isinstance(trusted_log_vkey, str) or not trusted_log_vkey.strip():
        raise ReceiptError("untrusted log origin")
    if not isinstance(response, dict):
        raise ReceiptError("invalid receipt")
    pq = response.get("pq_trust")
    tr = pq.get("transparency") if isinstance(pq, dict) else None
    if not isinstance(tr, dict):
        raise ReceiptError("invalid receipt")
    receipt, reveal = tr.get("receipt"), tr.get("reveal")
    if not isinstance(receipt, dict) or not isinstance(reveal, dict):
        raise ReceiptError("invalid receipt")
    version = verify_reveal(reveal)
    public_leaf = {
        "commitment": reveal["commitment"].lower(),
        "nonce": reveal["nonce"],
        "ts": reveal["ts"],
        "type": version,
    }
    if not isinstance(public_leaf["nonce"], str) or not isinstance(public_leaf["ts"], str):
        raise ReceiptError("invalid reveal")
    expected_leaf = leaf_hash(canonical(public_leaf)).hex()
    leaf_hex = receipt.get("leaf_hash")
    if not isinstance(leaf_hex, str) or leaf_hex.lower() != expected_leaf:
        raise ReceiptError("leaf hash mismatch")
    verified = verify_receipt(receipt, trusted_log_vkey)
    verified["event_version"] = version
    return verified
