"""Read JSON request examples from documentation without executing shell code."""
from __future__ import annotations
from html.parser import HTMLParser
import json
import shlex


def _pairs(items):
    out = {}
    for key, value in items:
        if key in out:
            raise ValueError("duplicate JSON key in documentation: " + key)
        out[key] = value
    return out


def _constant(value):
    raise ValueError("non-finite JSON value in documentation: " + value)


def _request(raw: str) -> dict:
    value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=_constant)
    if not isinstance(value, dict):
        raise ValueError("documented request must be a JSON object")
    return value


class CodeBlocks(HTMLParser):
    """Collect object literals and inline curl JSON bodies from <code> blocks.

    Shell tokens are parsed as text only. No command, substitution, file read,
    environment expansion, network request or process is executed.
    """
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = None
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        if tag == "code":
            self.current = []

    def handle_data(self, text):
        if self.current is not None:
            self.current.append(text)

    def handle_endtag(self, tag):
        if tag != "code" or self.current is None:
            return
        value = "".join(self.current).strip()
        self.current = None
        if value.startswith("{") and value.endswith("}"):
            self.blocks.append(_request(value))
            return
        if not value.startswith("curl "):
            return
        tokens = shlex.split(value.replace("\\\n", ""), comments=True, posix=True)
        for i, token in enumerate(tokens):
            if token in ("--data", "--data-raw", "--json", "-d"):
                if i + 1 >= len(tokens):
                    raise ValueError("missing curl request body")
                raw = tokens[i + 1]
            elif token.startswith(("--data=", "--data-raw=", "--json=")):
                raw = token.split("=", 1)[1]
            else:
                continue
            if raw.startswith("{"):
                self.blocks.append(_request(raw))
