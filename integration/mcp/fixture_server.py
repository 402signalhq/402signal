"""Loopback MCP interoperability fixture. Synthetic authorizations only."""
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
import json
import os
import sys
import tempfile
from unittest.mock import patch

from live402.server import Handler
from live402 import replay
from test_pay_replay import _payload, _headers_for, _fake_facilitator


with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
    stack.enter_context(patch.dict(os.environ, LIVE402_FIXTURE='1', LOCAL_FREE='',
        LIVE402_REPLAY_DB=temp + '/replay.sqlite', LIVE402_HISTORY_DB=temp + '/history.sqlite',
        LIVE402_CATALOG_DB=temp + '/catalog.sqlite', CDP_ACCESS_TOKEN='test-fixture-token'))
    stack.enter_context(patch('live402.facilitator.post_json', side_effect=_fake_facilitator))
    app = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    headers = _headers_for(_payload('official-mcp-client', resource_url='https://402signal.com/mcp'))
    print(json.dumps({'url': 'http://127.0.0.1:' + str(app.server_port) + '/mcp', 'headers': headers}), flush=True)
    try:
        app.serve_forever()
    finally:
        app.server_close()
        replay.reset_memory()
