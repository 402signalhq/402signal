"""Tiny stdlib HTTP server for 402Signal. Port 8081 — AnalogPair stays on 8080."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import socket
import sys
import threading
import time
import uuid
from collections import OrderedDict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from live402 import asset_version, capabilities, catalog, discover, history, mcp, payment, pulse, rails, ready, reqctx, validate
from live402 import admission, http_body, replay, developer_guides
from live402.http_body import BodyReadError
from live402.route import handle_route, recover_route

STATIC_DIR = Path(__file__).resolve().parent / "static"
MCP_REGISTRY_PATH = "/mcp/v0.3.1"
X402LIST_VERIFY_TOKEN = "x402list-verify-52dmS9yTO-vP6AMJh6H8mZZBInntQZP7zSLPF806CnQ"
# Human pages served as static HTML from STATIC_DIR. Same CSP as GET /.
HUMAN_PAGES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/catalog": "catalog.html",
    "/catalog.html": "catalog.html",
    "/how": "how.html",
    "/how.html": "how.html",
    "/developers": "developers.html",
    "/developers.html": "developers.html",
    "/insights/pre-spend-routing": "pre-spend-routing.html",
    "/insights/pre-spend-routing.html": "pre-spend-routing.html",
    "/contact": "contact.html",
    "/contact.html": "contact.html",
    "/privacy": "privacy.html",
    "/privacy.html": "privacy.html",
    "/terms": "terms.html",
    "/terms.html": "terms.html",
}
