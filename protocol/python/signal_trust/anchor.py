"""Existing PQ1 note and fetched-transaction verification, extracted read-only.

Checks structure and matching pinned checkpoint fields; it does not perform
Falcon signature mathematics or independently prove Algorand consensus.
Callers provide transaction data from their trusted chain reader and an explicit
network. No service environment, signing, broadcast, HTTP, or storage is used.
"""
from __future__ import annotations
import base64
import hashlib
import json
import re
from . import algo_tx, checkpoint as ckpt, network as netcfg
from .merkle import HASH_SIZE
NOTE_FORMAT = "402sg/pq1:b"
NOTE_VERSION = 1

def _expected_network_name(expected_network: str | None = None) -> str:
    raw = (expected_network or "").strip().lower()
    if raw not in netcfg.NETWORKS:
        raise AnchorError("explicit known network required")
    return raw

NOTE_PREFIX = NOTE_FORMAT.encode("ascii")

NOTE_LEN = 84

PROTOCOL_BASE_MIN = netcfg.PROTOCOL_BASE_MIN

FALCON_EXTRA_MIN_MULT = netcfg.FALCON_EXTRA_MIN_MULT

MAX_FEE = netcfg.MAX_FEE

FALCON_F1_PK_LEN = netcfg.FALCON_F1_PK_LEN

FALCON_F1_SIG_MAX = netcfg.FALCON_F1_SIG_MAX

FALCON_F1_SIG_MIN = netcfg.FALCON_F1_SIG_MIN

FALCON_F1_SIG_HEADER = netcfg.FALCON_F1_SIG_HEADER

FALCON_F1_SIG_SALT_VERSION = netcfg.FALCON_F1_SIG_SALT_VERSION

TESTNET_GENESIS_ID = netcfg.TESTNET_GENESIS_ID

TESTNET_GENESIS_HASH = netcfg.TESTNET_GENESIS_HASH

PQSIG_MARKER = "present"

PQSIG_SCHEME_F1 = "f1"

_EXCLUSIVE_SIG_KEYS = frozenset({"sig", "multisig", "logicsig", "msig", "lsig"})

_TXID_RE = re.compile(r"^[A-Z2-7]{52}$")

_PLACEHOLDER_TXID = frozenset({"", "your_txid", "placeholder", "txid", "none", "null"})

class AnchorError(ValueError):
    pass

def origin_hash(origin: str) -> bytes:
    text = (origin or "").replace("\n", "")
    return hashlib.sha256(text.encode("utf-8")).digest()

def encode_note(origin: str, tree_size: int, root: bytes) -> bytes:
    if tree_size < 0:
        raise AnchorError("negative tree size")
    root_b = bytes(root)
    if len(root_b) != HASH_SIZE:
        raise AnchorError("root must be 32 bytes")
    note = (
        NOTE_PREFIX
        + bytes([NOTE_VERSION])
        + origin_hash(origin)
        + int(tree_size).to_bytes(8, "big")
        + root_b
    )
    if len(note) != NOTE_LEN:
        raise AnchorError("note must be 84 bytes")
    return note

def decode_note(note: bytes) -> dict:
    raw = bytes(note)
    if len(raw) != NOTE_LEN:
        raise AnchorError("note must be 84 bytes")
    if raw[:11] != NOTE_PREFIX or raw[11] != NOTE_VERSION:
        raise AnchorError("unknown note format")
    return {
        "format": NOTE_FORMAT,
        "version": NOTE_VERSION,
        "origin_hash": raw[12:44],
        "tree_size": int.from_bytes(raw[44:52], "big"),
        "root": raw[52:84],
    }

def c2sp_body_from_note(note: bytes, origin: str) -> str:
    """Round-trip: note + origin Ã¢â€ â€™ C2SP checkpoint body."""
    parsed = decode_note(note)
    if parsed["origin_hash"] != origin_hash(origin):
        raise AnchorError("origin hash mismatch")
    return ckpt.checkpoint_body(origin, parsed["tree_size"], parsed["root"])

def note_from_checkpoint_body(body_text: str) -> bytes:
    parsed = ckpt.parse_checkpoint_body(body_text)
    return encode_note(parsed["origin"], parsed["tree_size"], parsed["root"])

def _network_cfg(expected_network: str | None = None) -> netcfg.NetworkConfig:
    return netcfg.get_network(_expected_network_name(expected_network))

def protocol_base_min(params: dict | None = None) -> int:
    """algod min-fee: protocol base min for an ordinary txn (1000 today)."""
    p = params if isinstance(params, dict) else {}
    raw = p.get("minFee")
    if raw is None:
        raw = p.get("min-fee")
    if raw is None:
        return PROTOCOL_BASE_MIN
    try:
        n = int(raw)
    except (TypeError, ValueError) as exc:
        raise AnchorError("fee out of range") from exc
    if n < 1:
        raise AnchorError("fee out of range")
    return n

def falcon_min_fee(params: dict | None = None) -> int:
    """Uncongested Falcon-1024 floor: protocol base + 2x base (3000 today)."""
    return protocol_base_min(params) * (1 + FALCON_EXTRA_MIN_MULT)

def _genesis_hash_bytes(gen: str, gh):
    if isinstance(gh, (bytes, bytearray)) and gh:
        return bytes(gh)
    if isinstance(gh, str) and gh.strip():
        return base64.b64decode(gh)
    cfg = netcfg.network_for_genesis_id(gen)
    if cfg is not None:
        return base64.b64decode(cfg.genesis_hash)
    if gen == TESTNET_GENESIS_ID:
        return base64.b64decode(TESTNET_GENESIS_HASH)
    raise AnchorError("unknown genesis identity")

def _looks_like_txid(txid: str) -> bool:
    text = (txid or "").strip()
    low = text.lower()
    if low in _PLACEHOLDER_TXID or "placeholder" in low or text == "YOUR_TXID":
        return False
    return bool(_TXID_RE.match(text))

def _b64(val):
    if val is None or val == "":
        return b""
    if isinstance(val, (bytes, bytearray)):
        return bytes(val)
    text = str(val).strip()
    if not text:
        return b""
    try:
        return base64.b64decode(text)
    except Exception:
        try:
            return bytes.fromhex(text)
        except ValueError:
            return text.encode("utf-8")

def _addr_text(val) -> str:
    if val is None or val == "":
        return ""
    if isinstance(val, (bytes, bytearray)):
        if len(val) == 32:
            try:
                return algo_tx.encode_address(bytes(val))
            except ValueError:
                return ""
        return ""
    text = str(val).strip()
    if len(text) == 58:
        try:
            algo_tx.decode_address(text)
            return text
        except ValueError:
            return ""
    try:
        raw = _b64(text)
        if len(raw) == 32:
            return algo_tx.encode_address(raw)
    except Exception:
        return ""
    return ""

def _nonzero_blob(val) -> bool:
    if val is None or val == "" or val == 0:
        return False
    if isinstance(val, (bytes, bytearray)):
        return any(val)
    if isinstance(val, str):
        return bool(val.strip())
    return True

def _field_bytes_or_empty(val) -> bytes:
    if val is None or val == "":
        return b""
    if isinstance(val, (bytes, bytearray)):
        return bytes(val)
    return _b64(val)

def _ascii_ident(val):
    """Wire identifier as ASCII text. bytes decode strictly; never str(bytes)."""
    if isinstance(val, (bytes, bytearray)):
        try:
            return bytes(val).decode("ascii")
        except UnicodeDecodeError:
            return None
    if isinstance(val, str):
        return val
    return None

def _scheme_text(sch):
    """sch/scheme Ã¢â€ â€™ exact ASCII. bytes are [2]byte; str is used as-is. No strip."""
    return _ascii_ident(sch)

def _falcon_f1_shapes_ok(pk: bytes, sig: bytes) -> bool:
    """Official Falcon-1024 wire sizes. Nonempty is not enough.

    pk is exactly 1793. A compressed signature needs at least its header and
    salt-version bytes and may be at most 1423 bytes. These are structural
    bounds only; authenticated provenance or native verification establishes
    validity.
    """
    if not isinstance(pk, (bytes, bytearray)) or not isinstance(sig, (bytes, bytearray)):
        return False
    if len(pk) != FALCON_F1_PK_LEN:
        return False
    if len(sig) < FALCON_F1_SIG_MIN or len(sig) > FALCON_F1_SIG_MAX:
        return False
    if sig[0] != FALCON_F1_SIG_HEADER or sig[1] != FALCON_F1_SIG_SALT_VERSION:
        return False
    return True

def _salt_in_range(slt) -> bool:
    """slt/salt is optional. Accept 0-255 int or a single salt byte."""
    if slt is None or slt == "":
        return True
    if isinstance(slt, bool):
        return False
    if isinstance(slt, (bytes, bytearray)):
        return len(slt) <= 1
    try:
        salt = int(slt)
    except (TypeError, ValueError):
        return False
    return 0 <= salt <= 255

def _parse_pqsig_envelope(raw):
    """Official Algorand pqsig envelope. Codec {sch,slt,pk,sig} or indexer REST.

    sch/scheme must be exactly f1 (Falcon-1024). bytes decode as strict
    ASCII (algokey PQScheme [2]byte Ã¢â€ â€™ b"f1"); str is used as-is. No
    strip, no str(bytes), no case fold. slt/salt if present is 0-255.
    pk/public-key and sig/signature must be Falcon-1024 shaped: pk is
    exactly 1793 bytes; sig is FALCON_F1_SIG_MIN..FALCON_F1_SIG_MAX,
    begins with the compressed-signature header 0xba, and declares salt
    version 0. The confirmed tree-4 sample is 1230 bytes; the maximum is
    1423. These are structural checks, not cryptographic verification.
    Nonempty shorter/longer blobs fail. Fail closed on missing, empty,
    f5, F1, padded, or any other scheme. A bare blob (including
    signature.falcon) is not an envelope. The IPC marker
    pqsig:"present" is not authorization. Do not rewrite pqsig.
    """
    if not isinstance(raw, dict):
        return None
    if raw.get("pqsig") == PQSIG_MARKER or raw == PQSIG_MARKER:
        return None
    sch = raw.get("sch") if "sch" in raw else raw.get("scheme")
    if sch is None:
        return None
    scheme = _scheme_text(sch)
    if scheme != PQSIG_SCHEME_F1:
        return None
    slt = raw.get("slt") if "slt" in raw else raw.get("salt")
    if not _salt_in_range(slt):
        return None
    pk = _field_bytes_or_empty(raw.get("pk") if "pk" in raw else raw.get("public-key"))
    sig = _field_bytes_or_empty(raw.get("sig") if "sig" in raw else raw.get("signature"))
    if not pk or not sig:
        return None
    if pk == PQSIG_MARKER.encode("utf-8") or sig == PQSIG_MARKER.encode("utf-8"):
        return None
    if not _falcon_f1_shapes_ok(pk, sig):
        return None
    return bytes(sig)

def _sig_type_value(obj: dict) -> str:
    for key in ("sig-type", "sigType", "signature-type"):
        if key in obj and obj.get(key) is not None and obj.get(key) != "":
            ident = _ascii_ident(obj.get(key))
            if ident:
                return ident
    return ""

def _exclusive_sig_present(sig: dict) -> bool:
    for key in _EXCLUSIVE_SIG_KEYS:
        if key not in sig:
            continue
        val = sig.get(key)
        if val in (None, "", {}, []):
            continue
        if isinstance(val, (bytes, bytearray)) and not val:
            continue
        return True
    return False

def _pq_auth_from_obj(obj: dict):
    """Positive PQ/Falcon authorization from an official pqsig envelope.

    Accepts consensus SignedTxn codec tags (pqsig.{sch,slt,pk,sig}) and
    indexer REST TransactionSignaturePQsig (signature.pqsig with
    scheme/salt/public-key/signature). sch/scheme must be f1 after
    normalizing bytes (algokey PQScheme [2]byte) to ASCII.

    Fail closed: signature.falcon blobs, Ed25519 signature.sig, missing
    pqsig, empty/other scheme (including f5), missing or wrong-shaped
    pk/sig, the 6PN marker pqsig="present", and StateProof
    falcon-signature. Ceremony metadata is never authorization.
    Confirmed chain inclusion is trusted; this does not re-implement
    Falcon verify.
    """
    if not isinstance(obj, dict):
        return None
    if obj.get("pqsig") == PQSIG_MARKER:
        return None
    sig_type = _sig_type_value(obj)
    if sig_type and sig_type != "pqsig":
        return None
    sig = obj.get("signature")
    if isinstance(sig, dict):
        if "falcon-signature" in sig or "falcon" in sig or "falconsig" in sig:
            if "pqsig" not in sig:
                return None
        pq = sig.get("pqsig")
        if pq is not None:
            if _exclusive_sig_present(sig):
                return None
            parsed = _parse_pqsig_envelope(pq)
            return parsed
        if _exclusive_sig_present(sig):
            return None
        return None
    raw = obj.get("pqsig")
    if raw is not None:
        return _parse_pqsig_envelope(raw)
    return None

def decode_chain_txn(obj) -> dict:
    """Normalize indexer JSON, algod pending JSON, or a SignedTxn-shaped dict."""
    if not isinstance(obj, dict):
        raise AnchorError("invalid chain object")
    if obj.get("pqsig") == PQSIG_MARKER and "signed" in obj:
        raise AnchorError("pqsig marker is not a chain object")
    txn = obj.get("transaction") if isinstance(obj.get("transaction"), dict) else None
    pending = obj.get("txn") if isinstance(obj.get("txn"), dict) else None
    inner = None
    envelope = None
    if txn is not None:
        envelope = txn
        inner = txn.get("payment-transaction") if isinstance(txn.get("payment-transaction"), dict) else {}
        unsigned = txn
    elif pending is not None and isinstance(pending.get("txn"), dict):
        envelope = obj
        unsigned = pending.get("txn")
        inner = unsigned
    elif pending is not None:
        envelope = obj
        unsigned = pending
        inner = pending
    else:
        envelope = obj
        unsigned = obj
        inner = obj.get("payment-transaction") if isinstance(obj.get("payment-transaction"), dict) else obj

    txid = str(
        (txn or {}).get("id")
        or envelope.get("id")
        or obj.get("id")
        or obj.get("txid")
        or obj.get("txId")
        or ""
    ).strip()
    try:
        confirmed_round = int(
            (txn or {}).get("confirmed-round")
            or envelope.get("confirmed-round")
            or obj.get("confirmed-round")
            or obj.get("confirmed_round")
            or 0
        )
    except (TypeError, ValueError):
        confirmed_round = 0
    gen = str(
        unsigned.get("genesis-id")
        or unsigned.get("genesisID")
        or unsigned.get("gen")
        or obj.get("genesis-id")
        or obj.get("genesisID")
        or ""
    ).strip()
    tx_type = str(
        unsigned.get("tx-type")
        or unsigned.get("txType")
        or unsigned.get("type")
        or ""
    ).strip()
    sender = _addr_text(unsigned.get("sender") or unsigned.get("snd"))
    receiver = _addr_text(
        (inner or {}).get("receiver")
        or (inner or {}).get("rcv")
        or unsigned.get("receiver")
        or unsigned.get("rcv")
    )
    try:
        amount = int(
            (inner or {}).get("amount")
            if (inner or {}).get("amount") is not None
            else (unsigned.get("amt") if unsigned.get("amt") is not None else 0)
        )
    except (TypeError, ValueError):
        amount = -1
    try:
        fee = int(unsigned.get("fee") if unsigned.get("fee") is not None else 0)
    except (TypeError, ValueError):
        fee = -1
    try:
        fv = int(
            unsigned.get("first-valid")
            if unsigned.get("first-valid") is not None
            else unsigned.get("firstValid")
            if unsigned.get("firstValid") is not None
            else unsigned.get("fv")
            if unsigned.get("fv") is not None
            else (txn or {}).get("first-valid")
            if isinstance(txn, dict) and (txn or {}).get("first-valid") is not None
            else 0
        )
    except (TypeError, ValueError):
        fv = 0
    try:
        lv = int(
            unsigned.get("last-valid")
            if unsigned.get("last-valid") is not None
            else unsigned.get("lastValid")
            if unsigned.get("lastValid") is not None
            else unsigned.get("lv")
            if unsigned.get("lv") is not None
            else (txn or {}).get("last-valid")
            if isinstance(txn, dict) and (txn or {}).get("last-valid") is not None
            else 0
        )
    except (TypeError, ValueError):
        lv = 0
    gh = (
        unsigned.get("genesis-hash")
        or unsigned.get("genesisHash")
        or unsigned.get("gh")
        or obj.get("genesis-hash")
        or obj.get("genesisHash")
        or ""
    )
    if isinstance(gh, (bytes, bytearray)):
        genesis_hash = base64.b64encode(bytes(gh)).decode("ascii")
    else:
        genesis_hash = str(gh or "").strip()
    note = unsigned.get("note")
    if isinstance(note, str):
        note = _b64(note)
    elif isinstance(note, (bytes, bytearray)):
        note = bytes(note)
    else:
        note = b""
    close = (
        (inner or {}).get("close-remainder-to")
        or (inner or {}).get("close")
        or unsigned.get("close-remainder-to")
        or unsigned.get("close")
    )
    rekey = unsigned.get("rekey-to") or unsigned.get("rekey")
    group = unsigned.get("group") or unsigned.get("grp")
    lease = unsigned.get("lease") or unsigned.get("lx")
    pq_auth = _pq_auth_from_obj(obj)
    if pq_auth is None and pending is not None:
        pq_auth = _pq_auth_from_obj(pending)
    if pq_auth is None and txn is not None:
        pq_auth = _pq_auth_from_obj(txn)
    if pq_auth is None and isinstance(envelope, dict) and envelope is not obj:
        pq_auth = _pq_auth_from_obj(envelope)
    auth_addr = _auth_addr_field(obj, envelope, txn, pending, unsigned, inner)
    return {
        "txid": txid,
        "confirmed_round": confirmed_round,
        "genesis_id": gen,
        "tx_type": tx_type,
        "sender": sender,
        "receiver": receiver,
        "auth_addr": auth_addr,
        "authorizer": sender,
        "amount": amount,
        "fee": fee,
        "fv": fv,
        "lv": lv,
        "genesis_hash": genesis_hash,
        "note": note,
        "close": close,
        "rekey": rekey,
        "group": group,
        "lease": lease,
        "has_axfer": "asset-transfer-transaction" in (txn or unsigned)
        or str(tx_type) == "axfer"
        or "aamt" in unsigned
        or "xaid" in unsigned,
        "has_appl": "application-transaction" in (txn or unsigned)
        or str(tx_type) == "appl"
        or "apid" in unsigned,
        "pq_auth": pq_auth,
    }

def _auth_addr_field(*objs):
    """Codec sgnr or REST/indexer auth-addr / authAddr. Empty if self-authorized."""
    for obj in objs:
        if not isinstance(obj, dict):
            continue
        for key in ("sgnr", "auth-addr", "authAddr", "auth_addr"):
            if key not in obj:
                continue
            val = obj.get(key)
            if _nonzero_blob(val):
                return val
    return ""

def reconstruct_txid_from_decoded(decoded: dict, *, expected_address: str = "") -> tuple[str | None, list[str]]:
    """Recompute Algorand txid when Indexer returned enough unsigned fields.

    Returns (txid, missing_fields). missing_fields empty means the
    unsigned payload was reconstructed. Provider-omitted fields are
    listed so callers can fall back to semantic + provider-txid compare.
    """
    missing = []
    if not isinstance(decoded, dict):
        return None, ["decoded"]
    fee = decoded.get("fee")
    fv = decoded.get("fv")
    lv = decoded.get("lv")
    gen = str(decoded.get("genesis_id") or "").strip()
    gh = decoded.get("genesis_hash")
    note = decoded.get("note")
    sender = str(decoded.get("sender") or "").strip()
    receiver = str(decoded.get("receiver") or "").strip()
    addr = (expected_address or sender or "").strip()
    if fee in (None, "") or int(fee) < 0:
        missing.append("fee")
    if not fv:
        missing.append("fv")
    if not lv:
        missing.append("lv")
    if not gen:
        missing.append("genesis_id")
    if not gh:
        missing.append("genesis_hash")
    if not note:
        missing.append("note")
    if not sender:
        missing.append("sender")
    if not receiver:
        missing.append("receiver")
    if missing:
        return None, missing
    try:
        gh_bytes = _genesis_hash_bytes(gen, gh)
        txn = algo_tx.pay_txn(
            sender or addr,
            receiver or addr,
            0,
            int(fee),
            int(fv),
            int(lv),
            gen,
            gh_bytes,
            note=bytes(note),
        )
        extra = set(txn) - {"type", "fee", "fv", "gen", "gh", "lv", "note", "rcv", "snd"}
        for key in extra:
            txn.pop(key, None)
        txid = algo_tx.txid_from_unsigned(txn)
    except Exception:
        return None, ["reconstruct"]
    if not _looks_like_txid(txid):
        return None, ["reconstruct"]
    return txid, []

def verify_fetched_anchor(
    decoded: dict,
    *,
    expected_origin: str,
    expected_size: int,
    expected_root,
    expected_address: str,
    expected_txid: str | None = None,
    expected_network: str | None = None,
    expected_fee: int | None = None,
    expected_fv: int | None = None,
    expected_lv: int | None = None,
) -> dict:
    """Fail closed unless the fetched txn matches PQ1 construction.

    Expected Falcon checkpoint is self-authorized: configured Falcon
    address == sender == receiver == authorizing account. Any nonempty
    AuthAddr (codec sgnr, REST auth-addr / authAddr) fails confirmation.
    Genesis must exactly match expected_network.
    When expected_fee / expected_fv / expected_lv are set, the fetched
    fields must equal the stored authorized values if Indexer returned
    them. A provider that claims the expected txid but mutates fee/fv/lv
    is rejected.
    """
    if not isinstance(decoded, dict):
        raise AnchorError("invalid chain object")
    pq_auth = decoded.get("pq_auth")
    if not isinstance(pq_auth, (bytes, bytearray)) or not pq_auth:
        raise AnchorError("falcon authorization missing")
    if bytes(pq_auth) == PQSIG_MARKER.encode("utf-8"):
        raise AnchorError("pqsig marker is not authorization")
    cfg = _network_cfg(expected_network)
    gen = str(decoded.get("genesis_id") or "")
    if gen != cfg.genesis_id:
        raise AnchorError("genesis mismatch")
    addr = (expected_address or "").strip()
    if not addr:
        raise AnchorError("falcon address required")
    if _nonzero_blob(decoded.get("auth_addr")):
        raise AnchorError("auth address forbidden")
    if decoded.get("sender") != addr or decoded.get("receiver") != addr:
        raise AnchorError("sender/receiver mismatch")
    authorizer = decoded.get("authorizer") or decoded.get("sender")
    if authorizer != addr:
        raise AnchorError("authorizer mismatch")
    if int(decoded.get("amount") or 0) != 0:
        raise AnchorError("amount must be 0")
    fee = int(decoded.get("fee") or 0)
    if fee < falcon_min_fee() or fee > MAX_FEE:
        raise AnchorError("fee out of range")
    if expected_fee is not None and decoded.get("fee") not in (None, "", -1):
        if int(decoded.get("fee")) != int(expected_fee):
            raise AnchorError("fetched fee mismatch")
    if expected_fv is not None and int(decoded.get("fv") or 0) not in (0,):
        if int(decoded.get("fv")) != int(expected_fv):
            raise AnchorError("fetched fv mismatch")
    if expected_lv is not None and int(decoded.get("lv") or 0) not in (0,):
        if int(decoded.get("lv")) != int(expected_lv):
            raise AnchorError("fetched lv mismatch")
    if _nonzero_blob(decoded.get("close")):
        raise AnchorError("close forbidden")
    if _nonzero_blob(decoded.get("rekey")):
        raise AnchorError("rekey forbidden")
    if _nonzero_blob(decoded.get("group")):
        raise AnchorError("group forbidden")
    if _nonzero_blob(decoded.get("lease")):
        raise AnchorError("lease forbidden")
    if decoded.get("has_axfer") or decoded.get("has_appl"):
        raise AnchorError("axfer/appl forbidden")
    tx_type = str(decoded.get("tx_type") or "")
    if tx_type and tx_type not in {"pay", "payment"}:
        raise AnchorError("not a payment")
    try:
        parsed = decode_note(bytes(decoded.get("note") or b""))
    except Exception as exc:
        raise AnchorError("invalid note") from exc
    if parsed["origin_hash"] != origin_hash(expected_origin):
        raise AnchorError("origin mismatch")
    if int(parsed["tree_size"]) != int(expected_size):
        raise AnchorError("tree size mismatch")
    if isinstance(expected_root, (bytes, bytearray)):
        want_root = bytes(expected_root)
    else:
        try:
            want_root = bytes.fromhex(str(expected_root or ""))
        except ValueError as exc:
            raise AnchorError("invalid root") from exc
    if parsed["root"] != want_root:
        raise AnchorError("root mismatch")
    rnd = int(decoded.get("confirmed_round") or 0)
    if rnd < 1:
        raise AnchorError("not confirmed")
    txid = str(decoded.get("txid") or "").strip()
    if not _looks_like_txid(txid):
        raise AnchorError("invalid confirmed fields")
    if expected_txid and txid != expected_txid.strip():
        raise AnchorError("txid mismatch")
    recomputed, missing = reconstruct_txid_from_decoded(decoded, expected_address=addr)
    if recomputed:
        want = (expected_txid or txid).strip()
        if recomputed != want:
            raise AnchorError("reconstructed txid mismatch")
    return {
        "txid": txid,
        "confirmed_round": rnd,
        "tree_size": int(parsed["tree_size"]),
        "origin": expected_origin,
        "root": parsed["root"],
        "pq_auth": bytes(pq_auth),
        "network": cfg.name,
        "genesis_id": cfg.genesis_id,
        "reconstructed_txid": recomputed or "",
        "indexer_missing_fields": missing,
    }

def is_pq1_construction(decoded: dict, *, expected_address: str = "") -> bool:
    """Structural PQ1 check. Does not confirm inclusion or a checkpoint."""
    if not isinstance(decoded, dict):
        return False
    pq_auth = decoded.get("pq_auth")
    if not isinstance(pq_auth, (bytes, bytearray)) or not pq_auth:
        return False
    if bytes(pq_auth) == PQSIG_MARKER.encode("utf-8"):
        return False
    if _nonzero_blob(decoded.get("auth_addr")):
        return False
    addr = (expected_address or "").strip()
    sender = decoded.get("sender") or ""
    receiver = decoded.get("receiver") or ""
    if addr and (sender != addr or receiver != addr):
        return False
    if sender and receiver and sender != receiver:
        return False
    if int(decoded.get("amount") or 0) != 0:
        return False
    try:
        fee = int(decoded.get("fee") or 0)
    except (TypeError, ValueError):
        return False
    if fee < falcon_min_fee() or fee > MAX_FEE:
        return False
    if _nonzero_blob(decoded.get("close")) or _nonzero_blob(decoded.get("rekey")):
        return False
    if _nonzero_blob(decoded.get("group")) or _nonzero_blob(decoded.get("lease")):
        return False
    if decoded.get("has_axfer") or decoded.get("has_appl"):
        return False
    tx_type = str(decoded.get("tx_type") or "")
    if tx_type and tx_type not in {"pay", "payment"}:
        return False
    try:
        decode_note(bytes(decoded.get("note") or b""))
    except Exception:
        return False
    return True
