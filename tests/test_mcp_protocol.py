import json
import unittest
from unittest.mock import patch
from live402 import mcp
from test_mcp_batch_accounting import _serve
from http.client import HTTPConnection


class McpProtocolTests(unittest.TestCase):
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
