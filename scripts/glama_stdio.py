"""Credential-free stdio transport for the hosted 402Signal MCP service.

Free tools work through this adapter. Paid routing requires an x402-capable
HTTP client; HTTP 402 is exposed as a tool error containing the payment challenge.
This adapter never signs payments or forwards credentials from the environment.
"""

import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ENDPOINT = "https://402signal.com/mcp/v0.3.1"
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
PAYMENT_NOTE = (
    "This stdio adapter connects to the hosted 402Signal service. Preview and "
    "validate are free. Paid route calls require an x402-capable HTTP client at "
    + ENDPOINT + ". This adapter does not sign or submit payments."
)


def _error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id,
            "error": {"code": code, "message": message}}


def forward(message, opener=urlopen, protocol_version=None):
    """Forward one MCP message and translate HTTP failures into MCP responses."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        return _error(None, -32600, "Invalid Request")
    request_id = message.get("id")
    is_notification = "id" not in message
    if not is_notification and (isinstance(request_id, bool) or not isinstance(request_id, (str, int))):
        return _error(None, -32600, "Invalid request id")
    request = Request(ENDPOINT, json.dumps(message).encode("utf-8"), headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "402Signal-Glama-stdio/0.1.0",
    }, method="POST")
    if protocol_version is not None:
        request.add_header("MCP-Protocol-Version", protocol_version)
    try:
        with opener(request, timeout=25) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if is_notification:
            return None
        if len(body) > MAX_RESPONSE_BYTES:
            return _error(request_id, -32000, "Hosted service response exceeds adapter limit")
        result = json.loads(body)
        if not isinstance(result, dict) or result.get("jsonrpc") != "2.0" or result.get("id") != request_id:
            return _error(request_id, -32000, "Invalid hosted service response")
        if message["method"] == "initialize" and isinstance(result.get("result"), dict):
            existing = result["result"].get("instructions", "")
            result["result"]["instructions"] = (existing + "\n\n" + PAYMENT_NOTE).strip()
        return result
    except HTTPError as exc:
        if is_notification:
            return None
        if exc.code == 402 and message["method"] == "tools/call":
            challenge = exc.read(MAX_RESPONSE_BYTES).decode("utf-8", errors="replace")
            return {"jsonrpc": "2.0", "id": request_id, "result": {
                "content": [{"type": "text", "text": PAYMENT_NOTE + "\n\nHTTP 402 payment challenge:\n" + challenge}],
                "isError": True,
            }}
        return _error(request_id, -32000, "Hosted service returned HTTP " + str(exc.code))
    except (URLError, TimeoutError, OSError, ValueError):
        if is_notification:
            return None
        return _error(request_id, -32000, "Hosted service unavailable or returned invalid JSON")


class HostedClient:
    """Keep the negotiated HTTP protocol version for one stdio connection."""

    def __init__(self, opener=urlopen):
        self.opener = opener
        self.protocol_version = None

    def __call__(self, message):
        result = forward(message, self.opener, self.protocol_version)
        if isinstance(message, dict) and message.get("method") == "initialize" and isinstance(result, dict):
            initialized = result.get("result")
            if isinstance(initialized, dict) and isinstance(initialized.get("protocolVersion"), str):
                self.protocol_version = initialized["protocolVersion"]
        return result


def serve(input_stream, output_stream, forwarder=None):
    """Read and write newline-delimited MCP JSON; stdout is protocol-only."""
    if forwarder is None:
        forwarder = HostedClient()
    while True:
        line = input_stream.readline(MAX_MESSAGE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_MESSAGE_BYTES:
            output_stream.write(json.dumps(_error(None, -32600, "Request exceeds adapter limit")) + "\n")
            output_stream.flush()
            return
        try:
            message = json.loads(line)
        except (ValueError, UnicodeError):
            result = _error(None, -32700, "Parse error")
        else:
            result = forwarder(message)
        if result is not None:
            output_stream.write(json.dumps(result, ensure_ascii=True) + "\n")
            output_stream.flush()


if __name__ == "__main__":
    serve(sys.stdin.buffer, sys.stdout)
