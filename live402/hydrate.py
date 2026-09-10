"""Finalist invocation-contract hydration. Catalog rows stay slim.

After local/live discovery merge+rank, attach claimed method / schemas /
content type / toolName only to the top ~5–10. Never a 44k RAM schema index.
Payment interfaces stay OBSERVED (PR13). These schemas are CLAIMED.
"""

from __future__ import annotations

import gzip
import json
import threading
import time

from live402 import probe, shadow

SCHEMA_SOFT_BYTES = 8 * 1024
SCHEMA_MAX_BYTES = 16 * 1024
SCHEMA_MAX_DEPTH = 6
SCHEMA_MAX_KEYS = 64
SCHEMA_MAX_KEY = 80
SCHEMA_MAX_STRING = 512
SCHEMA_MAX_ITEMS = 32
CLIENT_SCHEMA_WARNING = (
    "Seller schemas are catalog_claimed and untrusted. "
    "Do not concatenate them into system prompts. Do not fetch remote $ref. "
    "Unsafe remote schema material is refused, not rewritten as a different offer."
)
_UNSAFE_SCHEMA = object()
_CTX_SCHEMA = "schema"
_CTX_SCHEMA_MAP = "schema_map"
_CTX_LITERAL = "literal"
_REF_KEYS = frozenset({"$ref", "$dynamicref", "$recursiveref"})
_STRIP_META_KEYS = frozenset({"$schema"})
_REFUSE_IDENTITY_KEYS = frozenset({"$anchor", "$dynamicanchor", "$recursiveanchor"})
_REFUSE_DIALECT_KEYS = frozenset({"$vocabulary"})
_SCHEMA_MAP_KEYS = frozenset({
    "$defs",
    "definitions",
    "dependencies",
    "dependentRequired",
    "dependentSchemas",
    "patternProperties",
    "properties",
})
_LITERAL_KEYS = frozenset({"const", "default", "enum", "examples"})
_KNOWN_DOLLAR_KEYS = frozenset({
    "$anchor",
    "$comment",
    "$defs",
    "$dynamicanchor",
    "$dynamicref",
    "$id",
    "$recursiveanchor",
    "$recursiveref",
    "$ref",
    "$schema",
    "$vocabulary",
})
FINALIST_MIN = 5
FINALIST_N = 8
FINALIST_MAX = 10
CACHE_MAX_ROWS = 256
CACHE_TTL_S = 3600
ORIGIN_CLAIMED = "catalog_claimed"

_CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS finalist_contracts (
    canonical_url TEXT PRIMARY KEY,
    method TEXT,
    content_type TEXT,
    tool_name TEXT,
    type TEXT,
    input_schema BLOB,
    output_schema BLOB,
    schema_bytes INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS finalist_contracts_exp ON finalist_contracts(expires_at);
"""

_lock = threading.Lock()


def _now() -> int:
    return int(time.time())


def _json_bytes(obj) -> bytes | None:
    if obj is None:
        return None
    try:
        raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return raw


def _is_local_fragment_ref(val) -> bool:
    """True only for opaque in-document fragments. Never resolved or fetched."""
    if not isinstance(val, str):
        return False
    text = val.strip()
    return bool(text) and text.startswith("#") and "://" not in text and not text.startswith("#//")


def _is_local_json_pointer_ref(val) -> bool:
    """Same-document JSON Pointer. Meaning does not depend on $id/$anchor names."""
    if not _is_local_fragment_ref(val):
        return False
    text = val.strip()
    return text == "#" or text.startswith("#/")


def _is_strippable_schema_id(val) -> bool:
    """Root $id we can drop without changing same-document JSON Pointer refs."""
    if not isinstance(val, str):
        return False
    text = val.strip()
    return bool(text) and not text.startswith("#")


def _child_context(key: str) -> str:
    if key in _LITERAL_KEYS:
        return _CTX_LITERAL
    if key in _SCHEMA_MAP_KEYS or key.lower() == "$defs":
        return _CTX_SCHEMA_MAP
    return _CTX_SCHEMA


def schema_looks_present(obj) -> bool:
    """True when a seller blob claims a schema, including $ref-only shapes."""
    if not isinstance(obj, dict):
        return False
    if not obj:
        return True
    if probe.is_empty_object_input_contract(obj):
        return True
    if obj.get("properties") or obj.get("required") or obj.get("type"):
        return True
    for key in obj:
        if str(key).lower() in _REF_KEYS:
            return True
    return False


def sanitize_untrusted_schema(obj, depth: int = 0):
    """Bound untrusted JSON Schema. Never fetch $ref.

    Traversal is schema-context-aware: schema-object keywords, property-name
    maps (properties / patternProperties / dependentSchemas / $defs /
    definitions), and literal JSON (const / enum / default / examples) are
    distinct. Property names and literal values are preserved exactly.

    Remote, protocol-relative, or non-fragment $ref / $dynamicRef / $recursiveRef
    fail closed (None) so a rewritten body cannot look like a different offer.
    Local JSON Pointer $ref stays an opaque string and is never resolved.
    $anchor and other local-identity constructs that would change meaning if
    $id/$anchor were stripped are refused, not rewritten. Unhandled dialect
    keywords refuse the whole schema. Depth, key, item, string, and
    null-constraint overflows also refuse the whole schema instead of
    forwarding a truncated substitute. JSON null is kept.
    """
    cleaned = _sanitize_untrusted_schema(obj, depth)
    return None if cleaned is _UNSAFE_SCHEMA else cleaned


def _sanitize_untrusted_schema(obj, depth: int = 0, ctx: str = _CTX_SCHEMA, *, root: bool = True):
    if depth > SCHEMA_MAX_DEPTH:
        return _UNSAFE_SCHEMA
    if isinstance(obj, dict):
        if len(obj) > SCHEMA_MAX_KEYS:
            return _UNSAFE_SCHEMA
        if ctx == _CTX_LITERAL:
            return _sanitize_literal_dict(obj, depth)
        if ctx == _CTX_SCHEMA_MAP:
            return _sanitize_schema_map(obj, depth)
        return _sanitize_schema_object(obj, depth, root=root)
    if isinstance(obj, list):
        if len(obj) > SCHEMA_MAX_ITEMS:
            return _UNSAFE_SCHEMA
        child_ctx = _CTX_LITERAL if ctx == _CTX_LITERAL else _CTX_SCHEMA
        out = []
        for item in obj:
            cleaned = _sanitize_untrusted_schema(item, depth + 1, child_ctx, root=False)
            if cleaned is _UNSAFE_SCHEMA:
                return _UNSAFE_SCHEMA
            out.append(cleaned)
        return out
    if isinstance(obj, str):
        if len(obj) > SCHEMA_MAX_STRING:
            return _UNSAFE_SCHEMA
        return obj
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    return _UNSAFE_SCHEMA


def _sanitize_literal_dict(obj: dict, depth: int):
    out = {}
    for key, val in obj.items():
        if not isinstance(key, str) or len(key) > SCHEMA_MAX_KEY:
            return _UNSAFE_SCHEMA
        cleaned = _sanitize_untrusted_schema(val, depth + 1, _CTX_LITERAL, root=False)
        if cleaned is _UNSAFE_SCHEMA:
            return _UNSAFE_SCHEMA
        out[key] = cleaned
    return out


def _sanitize_schema_map(obj: dict, depth: int):
    out = {}
    for key, val in obj.items():
        if not isinstance(key, str) or len(key) > SCHEMA_MAX_KEY:
            return _UNSAFE_SCHEMA
        cleaned = _sanitize_untrusted_schema(val, depth + 1, _CTX_SCHEMA, root=False)
        if cleaned is _UNSAFE_SCHEMA:
            return _UNSAFE_SCHEMA
        out[key] = cleaned
    return out


def _sanitize_schema_object(obj: dict, depth: int, *, root: bool):
    out = {}
    for key, val in obj.items():
        if not isinstance(key, str) or len(key) > SCHEMA_MAX_KEY:
            return _UNSAFE_SCHEMA
        lname = key.lower()
        if lname.startswith("$") and lname not in _KNOWN_DOLLAR_KEYS:
            return _UNSAFE_SCHEMA
        if lname in _REF_KEYS:
            if lname == "$ref" and _is_local_json_pointer_ref(val):
                text = val.strip()
                if len(text) > SCHEMA_MAX_STRING:
                    return _UNSAFE_SCHEMA
                out["$ref"] = text
                continue
            return _UNSAFE_SCHEMA
        if lname in _REFUSE_IDENTITY_KEYS or lname in _REFUSE_DIALECT_KEYS:
            return _UNSAFE_SCHEMA
        if lname == "$id":
            if root and _is_strippable_schema_id(val):
                continue
            return _UNSAFE_SCHEMA
        if lname in _STRIP_META_KEYS:
            continue
        cleaned = _sanitize_untrusted_schema(
            val, depth + 1, _child_context(key), root=False
        )
        if cleaned is _UNSAFE_SCHEMA:
            return _UNSAFE_SCHEMA
        out[key] = cleaned
    return out


def schema_is_unusable(obj) -> bool:
    """True when a claimed/live schema must not be forwarded."""
    cleaned, _n, truncated = _bounded_schema(obj)
    if truncated:
        return True
    return schema_looks_present(obj) and not isinstance(cleaned, dict)


def forward_untrusted_schema(obj) -> dict | None:
    """Return a bounded schema only when it is safe to expose. Else None.

    Oversize, overflow, remote/relative $ref, and other limit hits refuse the
    whole schema. The caller must keep any signed/observed original intact
    and not emit a rewritten substitute.
    """
    cleaned, _n, truncated = _bounded_schema(obj)
    if truncated or not isinstance(cleaned, dict):
        return None
    if cleaned:
        return cleaned
    # ``{}`` is an explicit no-input contract. Stripped-to-empty junk is not.
    return {} if probe.is_empty_object_input_contract(obj) else None


def _bounded_schema(obj) -> tuple[dict | None, int, bool]:
    """Return (schema, bytes, truncated). Oversize or unsafe $ref is dropped.

    This function never fetches $ref. Unsafe material is refused entirely.
    An explicit empty object (``{}``) is kept as a no-input contract.
    """
    if not isinstance(obj, dict):
        return None, 0, False
    if not obj:
        raw = _json_bytes(obj)
        return {}, (len(raw) if raw is not None else 2), False
    original = _json_bytes(obj)
    if original is not None and len(original) > SCHEMA_MAX_BYTES:
        return None, len(original), True
    cleaned = _sanitize_untrusted_schema(obj)
    if cleaned is _UNSAFE_SCHEMA:
        return None, len(original) if original is not None else 0, True
    if not isinstance(cleaned, dict):
        return None, 0, False
    if not cleaned:
        raw = _json_bytes(cleaned)
        n = len(raw) if raw is not None else 2
        if probe.is_empty_object_input_contract(obj):
            return {}, n, False
        return None, 0, False
    raw = _json_bytes(cleaned)
    if raw is None:
        return None, 0, False
    n = len(raw)
    if n > SCHEMA_MAX_BYTES:
        return None, n, True
    return cleaned, n, False


def _pack(obj) -> bytes | None:
    raw = _json_bytes(obj)
    if raw is None:
        return None
    if len(raw) > SCHEMA_MAX_BYTES:
        return None
    return gzip.compress(raw, compresslevel=6)


def _unpack(blob) -> dict | None:
    if blob is None:
        return None
    try:
        if isinstance(blob, memoryview):
            blob = blob.tobytes()
        raw = gzip.decompress(blob)
        if len(raw) > SCHEMA_MAX_BYTES:
            return None
        obj = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _content_type(item: dict) -> str | None:
    for key in ("contentType", "mimeType", "content_type"):
        val = item.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:80]
    bazaar = ((item.get("extensions") or {}).get("bazaar") or {})
    info = bazaar.get("info") if isinstance(bazaar, dict) else {}
    inp = (info or {}).get("input") if isinstance(info, dict) else {}
    if isinstance(inp, dict):
        body_type = str(inp.get("bodyType") or "").strip().lower()
        if body_type == "json":
            return "application/json"
        if body_type == "form-data":
            return "multipart/form-data"
        if body_type == "text":
            return "text/plain"
        headers = inp.get("headers") if isinstance(inp.get("headers"), dict) else {}
        for hk, hv in headers.items():
            if str(hk).lower() == "content-type" and str(hv).strip():
                return str(hv).strip()[:80]
    return None


def _tool_name(item: dict) -> str | None:
    if item.get("toolName"):
        text = str(item.get("toolName") or "").strip()
        return text[:80] or None
    bazaar = ((item.get("extensions") or {}).get("bazaar") or {})
    info = bazaar.get("info") if isinstance(bazaar, dict) else {}
    inp = (info or {}).get("input") if isinstance(info, dict) else {}
    if isinstance(inp, dict) and inp.get("toolName"):
        text = str(inp.get("toolName") or "").strip()
        return text[:80] or None
    return None


def _item_type(item: dict) -> str | None:
    if item.get("type"):
        text = str(item.get("type") or "").strip().lower()
        if text in {"http", "mcp"}:
            return text
    bazaar = ((item.get("extensions") or {}).get("bazaar") or {})
    info = bazaar.get("info") if isinstance(bazaar, dict) else {}
    inp = (info or {}).get("input") if isinstance(info, dict) else {}
    if isinstance(inp, dict) and inp.get("type"):
        text = str(inp.get("type") or "").strip().lower()
        if text in {"http", "mcp"}:
            return text
    return None


def extract_claimed_contract(item: dict | None) -> dict | None:
    """Claimed invocation contract from a catalog/raw item. Never an observed 402."""
    if not isinstance(item, dict):
        return None
    existing = item.get("_claimed_contract")
    if isinstance(existing, dict) and existing.get("origin") == ORIGIN_CLAIMED:
        out = dict(existing)
        out["untrusted"] = True
        out.setdefault("client_warning", CLIENT_SCHEMA_WARNING)
        return out
    raw_in, in_source = probe.extract_input_schema_source(item)
    in_schema, in_n, in_trunc = _bounded_schema(raw_in)
    out_schema, out_n, out_trunc = _bounded_schema(probe.extract_output_schema(item))
    method = None
    try:
        method = probe.extract_method(item)
    except Exception:
        method = None
    tool = _tool_name(item)
    ctype = _content_type(item)
    kind = _item_type(item)
    schema_bytes = in_n + out_n
    truncated = bool(in_trunc or out_trunc)
    if not any((method, tool, ctype, kind, in_schema, out_schema, truncated)):
        if not item.get("_input_schema_present") and not item.get("_output_schema_present"):
            return None
    return {
        "origin": ORIGIN_CLAIMED,
        "untrusted": True,
        "method": method or "POST",
        "content_type": ctype,
        "tool_name": tool,
        "type": kind,
        "input_schema": in_schema,
        "output_schema": out_schema,
        "input_schema_source": in_source,
        "schema_bytes": schema_bytes,
        "truncated": truncated,
        "client_warning": CLIENT_SCHEMA_WARNING,
    }


def note_raw_item(item: dict | None, stash: dict | None, rail: str | None = None) -> None:
    """Stash a claimed contract keyed by URL. Caller owns stash. Not the slim row."""
    _ = rail
    if stash is None or not isinstance(item, dict):
        return
    url = probe._resource_url(item)
    if not url:
        return
    contract = extract_claimed_contract(item)
    if contract:
        stash[url] = contract


def strip_schemas(item: dict | None) -> dict | None:
    """Drop schema blobs from a working-set row. Keep present-flags."""
    if not isinstance(item, dict):
        return item
    item.pop("inputSchema", None)
    item.pop("outputSchema", None)
    item.pop("_claimed_contract", None)
    bazaar = ((item.get("extensions") or {}).get("bazaar") or {})
    if isinstance(bazaar, dict):
        bazaar.pop("schema", None)
        info = bazaar.get("info") if isinstance(bazaar.get("info"), dict) else None
        if isinstance(info, dict):
            inp = info.get("input") if isinstance(info.get("input"), dict) else None
            if isinstance(inp, dict):
                inp.pop("inputSchema", None)
                inp.pop("body", None)
            out = info.get("output") if isinstance(info.get("output"), dict) else None
            if isinstance(out, dict):
                out.pop("schema", None)
    return item


def apply_contract(item: dict, contract: dict | None) -> dict:
    """Attach a CLAIMED contract onto a finalist. Does not touch payment accepts."""
    if not isinstance(item, dict) or not isinstance(contract, dict):
        return item
    item["_claimed_contract"] = {
        "origin": ORIGIN_CLAIMED,
        "untrusted": True,
        "method": contract.get("method") or "POST",
        "content_type": contract.get("content_type"),
        "tool_name": contract.get("tool_name"),
        "type": contract.get("type"),
        "schema_bytes": int(contract.get("schema_bytes") or 0),
        "truncated": bool(contract.get("truncated")),
        "client_warning": contract.get("client_warning") or CLIENT_SCHEMA_WARNING,
    }
    in_schema = contract.get("input_schema")
    source = contract.get("input_schema_source")
    if isinstance(in_schema, dict) and (
        in_schema or probe.is_empty_object_input_contract(in_schema)
    ):
        if source == "bazaar":
            item["_input_schema_present"] = True
        else:
            item["inputSchema"] = in_schema
            item["_input_schema_present"] = True
    out_schema = contract.get("output_schema")
    if isinstance(out_schema, dict) and out_schema:
        if source != "bazaar":
            item["outputSchema"] = out_schema
        item["_output_schema_present"] = True
    if contract.get("tool_name") and not item.get("toolName"):
        item["toolName"] = contract["tool_name"]
    if contract.get("type") and not item.get("type"):
        item["type"] = contract["type"]
    if contract.get("content_type"):
        item.setdefault("contentType", contract["content_type"])
    bazaar = ((item.get("extensions") or {}).get("bazaar") or {})
    info = bazaar.get("info") if isinstance(bazaar, dict) else None
    inp = (info or {}).get("input") if isinstance(info, dict) else None
    if not isinstance(inp, dict):
        inp = {}
        info = dict(info or {})
        info["input"] = inp
        bazaar = dict(bazaar or {})
        bazaar["info"] = info
        item.setdefault("extensions", {})
        if isinstance(item["extensions"], dict):
            item["extensions"]["bazaar"] = bazaar
    if contract.get("method"):
        inp.setdefault("method", contract["method"])
    if contract.get("tool_name"):
        inp.setdefault("toolName", contract["tool_name"])
    if contract.get("type"):
        inp.setdefault("type", contract["type"])
    if source == "bazaar" and isinstance(in_schema, dict) and (
        in_schema or probe.is_empty_object_input_contract(in_schema)
    ):
        inp["inputSchema"] = in_schema
    if source == "bazaar" and isinstance(out_schema, dict) and out_schema:
        out = info.get("output") if isinstance(info.get("output"), dict) else {}
        out = dict(out)
        out.setdefault("schema", out_schema)
        info["output"] = out
    return item


def _ensure_table(cur) -> None:
    cur.executescript(_CACHE_SCHEMA)


def _evict(cur, now: int) -> None:
    cur.execute("DELETE FROM finalist_contracts WHERE expires_at <= ?", (now,))
    cur.execute("SELECT COUNT(*) FROM finalist_contracts")
    n = int(cur.fetchone()[0] or 0)
    if n <= CACHE_MAX_ROWS:
        return
    drop = n - CACHE_MAX_ROWS
    cur.execute(
        """
        DELETE FROM finalist_contracts WHERE canonical_url IN (
            SELECT canonical_url FROM finalist_contracts
            ORDER BY fetched_at ASC, canonical_url ASC LIMIT ?
        )
        """,
        (drop,),
    )


def cache_put(url: str, contract: dict | None, *, ttl_s: int = CACHE_TTL_S) -> bool:
    dest = (url or "").strip()
    if not dest or not isinstance(contract, dict):
        return False
    now = _now()
    ttl = int(ttl_s) if ttl_s else CACHE_TTL_S
    if ttl < 1:
        ttl = CACHE_TTL_S
    in_blob = _pack(contract.get("input_schema"))
    out_blob = _pack(contract.get("output_schema"))
    try:
        with shadow._lock:
            conn = shadow._connect()
            cur = conn.cursor()
            _ensure_table(cur)
            cur.execute(
                """
                INSERT INTO finalist_contracts (
                    canonical_url, method, content_type, tool_name, type,
                    input_schema, output_schema, schema_bytes, truncated,
                    fetched_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(canonical_url) DO UPDATE SET
                    method = excluded.method,
                    content_type = excluded.content_type,
                    tool_name = excluded.tool_name,
                    type = excluded.type,
                    input_schema = excluded.input_schema,
                    output_schema = excluded.output_schema,
                    schema_bytes = excluded.schema_bytes,
                    truncated = excluded.truncated,
                    fetched_at = excluded.fetched_at,
                    expires_at = excluded.expires_at
                """,
                (
                    dest,
                    contract.get("method"),
                    contract.get("content_type"),
                    contract.get("tool_name"),
                    contract.get("type"),
                    in_blob,
                    out_blob,
                    int(contract.get("schema_bytes") or 0),
                    1 if contract.get("truncated") else 0,
                    now,
                    now + ttl,
                ),
            )
            _evict(cur, now)
            conn.commit()
        return True
    except Exception:
        return False


def cache_get(url: str) -> dict | None:
    dest = (url or "").strip()
    if not dest:
        return None
    now = _now()
    try:
        with shadow._lock:
            conn = shadow._connect()
            cur = conn.cursor()
            _ensure_table(cur)
            cur.execute(
                """
                SELECT method, content_type, tool_name, type, input_schema, output_schema,
                       schema_bytes, truncated, expires_at
                FROM finalist_contracts WHERE canonical_url = ?
                """,
                (dest,),
            )
            row = cur.fetchone()
            if not row:
                return None
            if int(row["expires_at"] or 0) <= now:
                cur.execute("DELETE FROM finalist_contracts WHERE canonical_url = ?", (dest,))
                conn.commit()
                return None
            return {
                "origin": ORIGIN_CLAIMED,
                "method": row["method"] or "POST",
                "content_type": row["content_type"],
                "tool_name": row["tool_name"],
                "type": row["type"],
                "input_schema": _unpack(row["input_schema"]),
                "output_schema": _unpack(row["output_schema"]),
                "schema_bytes": int(row["schema_bytes"] or 0),
                "truncated": bool(row["truncated"]),
            }
    except Exception:
        return None


def cache_count() -> int:
    try:
        with shadow._lock:
            conn = shadow._connect()
            cur = conn.cursor()
            _ensure_table(cur)
            cur.execute("SELECT COUNT(*) FROM finalist_contracts")
            return int(cur.fetchone()[0] or 0)
    except Exception:
        return 0


def cache_clear() -> None:
    try:
        with shadow._lock:
            conn = shadow._connect()
            cur = conn.cursor()
            _ensure_table(cur)
            cur.execute("DELETE FROM finalist_contracts")
            conn.commit()
    except Exception:
        return


def finalist_count(n=None) -> int:
    if n is None:
        return FINALIST_N
    try:
        cap = int(n)
    except (TypeError, ValueError):
        return FINALIST_N
    return min(max(cap, FINALIST_MIN), FINALIST_MAX)


def _contract_for(item: dict, stash: dict | None) -> dict | None:
    url = probe._resource_url(item)
    if stash and url and url in stash:
        got = stash.get(url)
        if isinstance(got, dict):
            return got
    on_item = item.get("_claimed_contract")
    if isinstance(on_item, dict) and (
        item.get("inputSchema") or item.get("outputSchema") or on_item.get("input_schema")
    ):
        merged = dict(on_item)
        if item.get("inputSchema") and not merged.get("input_schema"):
            schema, n, trunc = _bounded_schema(item.get("inputSchema"))
            merged["input_schema"] = schema
            merged["schema_bytes"] = int(merged.get("schema_bytes") or 0) + n
            merged["truncated"] = bool(merged.get("truncated") or trunc)
        if item.get("outputSchema") and not merged.get("output_schema"):
            schema, n, trunc = _bounded_schema(item.get("outputSchema"))
            merged["output_schema"] = schema
            merged["schema_bytes"] = int(merged.get("schema_bytes") or 0) + n
            merged["truncated"] = bool(merged.get("truncated") or trunc)
        return merged
    extracted = extract_claimed_contract(item)
    if extracted and (extracted.get("input_schema") or extracted.get("output_schema") or extracted.get("tool_name")):
        return extracted
    if url:
        cached = cache_get(url)
        if cached:
            return cached
    return extracted


def hydrate_finalists(
    ranked: list,
    stash: dict | None = None,
    n: int | None = None,
    *,
    persist: bool = True,
) -> list:
    """Hydrate only the top finalists. Strip schema blobs from the rest.

    Catalog/sqlite resource rows stay slim. Disk cache is bounded + TTL + gzip.
    """
    if not isinstance(ranked, list) or not ranked:
        return ranked
    cap = finalist_count(n)
    for idx, item in enumerate(ranked):
        if not isinstance(item, dict):
            continue
        if idx < cap:
            contract = _contract_for(item, stash)
            if contract:
                apply_contract(item, contract)
                if persist:
                    url = probe._resource_url(item)
                    if url:
                        cache_put(url, contract)
        else:
            strip_schemas(item)
    return ranked
