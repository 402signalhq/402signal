import json
import unittest
from unittest.mock import patch
from live402 import mcp
from test_mcp_batch_accounting import _serve
from http.client import HTTPConnection


class McpProtocolTests(unittest.TestCase):
    def test_discovery_admission_covers_handshake_not_paid_route(self):
        self.assertTrue(mcp.uses_discovery_admission({"jsonrpc": "2.0", "id": 1, "method": "initialize"}))
        self.assertTrue(mcp.uses_discovery_admission({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        self.assertTrue(mcp.uses_discovery_admission({"jsonrpc": "2.0", "id": 3, "method": "ping"}))
        self.assertTrue(mcp.uses_discovery_admission({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertTrue(mcp.uses_discovery_admission({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "preview"}}))
        self.assertFalse(mcp.uses_discovery_admission({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "validate"}}))
        self.assertFalse(mcp.uses_discovery_admission({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "route"}}))
        self.assertFalse(mcp.uses_discovery_admission({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "check"}}))
        self.assertTrue(mcp.is_paid_call({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "check"}}))

    def test_check_is_the_listed_paid_tool_and_route_stays_callable(self):
        names = [tool["name"] for tool in mcp.TOOLS]
        self.assertEqual(names, ["check", "preview", "validate"])
        check = mcp.TOOLS[0]
        self.assertTrue(check["description"].startswith("Runs the paid pre-flight check"))
        self.assertIn("$0.003", check["description"])
        self.assertIn("route is the former name of this tool", check["description"])
        self.assertEqual(mcp.FORMER_TOOL_NAMES, {"route": "check"})
        self.assertEqual(mcp.PAID_TOOLS, frozenset({"route", "check"}))
        # Every description names its siblings so an agent can choose without a link.
        for tool in mcp.TOOLS:
            for sibling in {"check", "preview", "validate"} - {tool["name"]}:
                self.assertIn(sibling, tool["description"], (tool["name"], sibling))
        # Annotations say what the handlers do: check spends the fee, the other two are read-only.
        self.assertEqual(check["annotations"], {
            "title": "Paid pre-flight check", "readOnlyHint": False, "destructiveHint": False,
            "idempotentHint": False, "openWorldHint": True,
        })
        for tool in mcp.TOOLS[1:]:
            self.assertTrue(tool["annotations"]["readOnlyHint"], tool["name"])
            self.assertFalse(tool["annotations"]["destructiveHint"], tool["name"])
            self.assertTrue(tool["annotations"]["idempotentHint"], tool["name"])
        for version in mcp.SUPPORTED_PROTOCOLS:
            status, result, _ = mcp.handle_mcp({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/list'},
                                               {'MCP-Protocol-Version': version}, 'unused')
            listed = result['result']['tools']
            self.assertEqual([t['name'] for t in listed], ['check', 'preview', 'validate'])
            self.assertTrue(all('annotations' in t for t in listed))
        body = {'live': True, 'billing': {'settled': True}}
        for name in ("check", "route"):
            with patch('live402.mcp.handle_route', return_value=(200, body, None)) as handled:
                status, result, _ = mcp.handle_mcp({'jsonrpc': '2.0', 'id': name + '-1', 'method': 'tools/call',
                    'params': {'name': name, 'arguments': {'url': 'https://seller.example/api'}}},
                    {'MCP-Protocol-Version': mcp.PROTOCOL_VERSION}, 'https://402signal.com/mcp')
            self.assertEqual((status, result['id']), (200, name + '-1'))
            self.assertEqual(result['result']['structuredContent'], body)
            self.assertEqual(handled.call_args.args[0], {'url': 'https://seller.example/api'})
        with patch('live402.mcp.handle_route', return_value=(402, {'error': 'payment_required'}, {'X-Test': '1'})):
            status, result, extra = mcp.handle_mcp({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                'params': {'name': 'check', 'arguments': {}}}, {}, 'https://402signal.com/mcp')
        self.assertEqual((status, extra), (402, {'X-Test': '1'}))

    def test_tool_envelopes_preserve_ids_and_error_semantics(self):
        for version in mcp.SUPPORTED_PROTOCOLS:
            headers = {'MCP-Protocol-Version': version}
            for code in (200, 400, 503):
                body = {'live': code == 200, 'billing': {'settled': code == 200}}
                with patch('live402.mcp.handle_route', return_value=(code, body, None)):
                    status, result, _ = mcp.handle_mcp({'jsonrpc':'2.0', 'id':'request-7', 'method':'tools/call',
                        'params':{'name':'route', 'arguments':{}}}, headers, 'https://402signal.com/mcp')
                self.assertEqual(status, 200)
                self.assertEqual(result['id'], 'request-7')
                self.assertEqual(result['result']['isError'], code != 200)
                self.assertEqual(json.loads(result['result']['content'][0]['text']), body)
                self.assertEqual('structuredContent' in result['result'], version == mcp.PROTOCOL_VERSION)

    def test_notification_does_not_execute_or_reply_and_invalid_request_is_correlated(self):
        with patch('live402.mcp.handle_route') as route:
            self.assertEqual(mcp.handle_mcp({'jsonrpc':'2.0','method':'tools/call','params':{'name':'route'}}, {}, 'unused'), (202, None, None))
            route.assert_not_called()
        status, result, _ = mcp.handle_mcp({'jsonrpc':'2.0','id':8,'method':'tools/call','params':{'name':'unknown'}}, {}, 'unused')
        self.assertEqual((status, result['id'], result['error']['code']), (200, 8, -32602))

    def test_http_notification_has_empty_body_and_untrusted_origin_is_denied(self):
        app, port = _serve()
        try:
            conn = HTTPConnection('127.0.0.1', port, timeout=2)
            payload = json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})
            conn.request('POST', '/mcp', payload, {'Content-Type':'application/json'})
            response = conn.getresponse()
            self.assertEqual(response.status, 202)
            self.assertEqual(response.read(), b'')
            conn.close()
            conn = HTTPConnection('127.0.0.1', port, timeout=2)
            conn.request('POST', '/mcp', payload, {'Content-Type':'application/json', 'Origin':'https://untrusted.invalid'})
            self.assertEqual(conn.getresponse().status, 403)
            conn.close()
        finally:
            app.shutdown()
            app.server_close()
