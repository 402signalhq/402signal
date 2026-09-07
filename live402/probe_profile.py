"""Explicit search-only unpaid probe. No arbitrary POST proxy or seller payment.

The body is private buyer input: only the designated endpoint receives it. Its
exact bytes are committed by the route binding; public leaves retain commitments.
"""
from dataclasses import dataclass, field
from live402 import route_binding

PROFILE = "parallel-search-json-v1"
URL = "https://parallelmpp.dev/api/search"
MAX_BYTES = 4096

class ProfileError(ValueError):
    """Constant diagnostics; never echo customer input."""

@dataclass(frozen=True)
class Request:
    url: str
    body: bytes = field(repr=False)

def parse(request):
    if not isinstance(request, dict) or "probe_request" not in request:
        return None
    raw = request["probe_request"]
    if (type(raw) is not dict or set(raw) != {"profile", "method", "body"}
            or raw.get("profile") != PROFILE or raw.get("method") != "POST"
            or request.get("url") != URL or "need" in request
            or request.get("require_route_binding") is not True):
        raise ProfileError("unsupported probe_request profile")
    body = raw["body"]
    try:
        if type(body) is not str or not 1 <= len(body.encode("utf-8")) <= MAX_BYTES:
            raise ProfileError("invalid probe_request body")
        value = route_binding.strict_json(body)
        if (type(value) is not dict or set(value) != {"query", "mode"}
                or type(value["query"]) is not str
                or not 1 <= len(value["query"]) <= 300 or not value["query"].strip()
                or value["mode"] != "one-shot"):
            raise ProfileError("invalid probe_request body")
        return Request(URL, body.encode("utf-8"))
    except (UnicodeError, route_binding.BindingError):
        raise ProfileError("invalid probe_request body") from None

def validate(request, url):
    if type(request) is not Request or request.url != url or url != URL or type(request.body) is not bytes:
        raise ProfileError("unsupported probe_request profile")
    try:
        checked = parse({"url": url, "require_route_binding": True, "probe_request": {
            "profile": PROFILE, "method": "POST", "body": request.body.decode("utf-8")}})
    except UnicodeError:
        raise ProfileError("invalid probe_request body") from None
    if checked != request:
        raise ProfileError("invalid probe_request body")

def input_schema():
    # A reviewed client-input profile, not an independently observed seller schema.
    return {"type": "object", "additionalProperties": False, "required": ["query", "mode"],
            "properties": {"query": {"type": "string", "minLength": 1, "maxLength": 300},
                           "mode": {"type": "string", "enum": ["one-shot"]}}}
