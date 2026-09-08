"""Export actual server-rendered pages and schemas in a disposable fixture.

Only fixed loopback GET requests are made. No production configuration, wallet,
payment header, signing account, paid routing request or external URL is used.
"""
from __future__ import annotations
import base64
from copy import deepcopy
import hashlib
from html.parser import HTMLParser
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
OUT = ROOT / 'website-evidence'
OUT.mkdir(exist_ok=True)
os.environ['LIVE402_FIXTURE'] = '1'
os.environ.pop('LOCAL_FREE', None)

class CodeBlocks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current = None
        self.blocks = []
    def handle_starttag(self, tag, attrs):
        if tag == 'code':
            self.current = []
    def handle_data(self, text):
        if self.current is not None:
            self.current.append(text)
    def handle_endtag(self, tag):
        if tag == 'code' and self.current is not None:
            value = ''.join(self.current).strip()
            if value.startswith('{') and value.endswith('}'):
                self.blocks.append(json.loads(value))
            self.current = None

def algo_address(byte):
    raw = bytes([byte])*32
    return base64.b32encode(raw + hashlib.new('sha512_256', raw).digest()[-4:]).decode().rstrip('=')

with tempfile.TemporaryDirectory(prefix='website-fixture-') as directory:
    for key, filename in [('LIVE402_PQ_LOG_DB', 'pq.sqlite'), ('LIVE402_HISTORY_DB', 'history.sqlite'),
                          ('LIVE402_CATALOG_DB', 'catalog.sqlite'), ('LIVE402_REPLAY_DB', 'replay.sqlite')]:
        os.environ[key] = str(Path(directory)/filename)
    from live402.server import Handler, CSP
    from live402 import schema_fields, batch_binding
    from live402.batch_profiles import base, solana, algorand_generic as algo
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    exports = {}
    try:
        for path, name in [('/transparency', 'transparency.html'), ('/dashboard', 'dashboard.html'),
                           ('/route', 'route.html'), ('/openapi.json', 'openapi.json'),
                           ('/mcp.json', 'mcp.json'), ('/pulse', 'pulse.json')]:
            connection = HTTPConnection('127.0.0.1', server.server_address[1], timeout=10)
            connection.request('GET', path, headers={'Accept': 'text/html' if name.endswith('.html') else 'application/json'})
            response = connection.getresponse()
            raw = response.read()
            assert response.status == 200, (path, response.status)
            if name.endswith('.html'):
                assert response.getheader('Content-Security-Policy') == CSP
            connection.close()
            (OUT/name).write_bytes(raw)
            exports[path] = name
    finally:
        server.shutdown()
        server.server_close()
    (OUT/'exports.json').write_text(json.dumps(exports))
    code = CodeBlocks()
    code.feed((ROOT/'live402/static/developers.html').read_text())
    assert len(code.blocks) >= 3
    cases = [{'name': 'documentation-'+str(i), 'request': block, 'valid': True} for i, block in enumerate(code.blocks)]
    cases += [{'name': 'ordinary', 'request': {'need': 'weather', 'require_route_binding': True}, 'valid': True},
              {'name': 'unknown-top-key', 'request': {'need': 'weather', 'privateKey': 'NOT_A_KEY'}, 'valid': False}]
    profiles = {
        'base-x402-batch-v1': {'network': base.NETWORK, 'asset': base.ASSET, 'recipient': '0x'+'11'*20,
            'receiver_authorizer': base.AUTHORIZER, 'withdraw_delay_seconds': 900,
            'max_call_amount_atomic': '1000', 'max_cumulative_amount_atomic': '2000', 'max_capital_atomic': '4000'},
        'solana-mpp-session-v1': {'network': solana.NETWORK, 'asset': solana.ASSET, 'recipient': solana.ASSET,
            'operator': solana.PROGRAM, 'program_id': solana.PROGRAM, 'max_session_cap_atomic': '4000'},
        'algorand-atomic-two-item-v1': {'network': algo.NETWORK, 'asset': algo.ASSET,
            'recipient': algo_address(1), 'fee_payer': algo_address(2), 'max_item_amount_atomic': '1000',
            'max_total_amount_atomic': '2000', 'max_sponsor_fee_micro_algo': '15000', 'job_hashes': ['a'*64, 'b'*64]},
    }
    for profile, limits in profiles.items():
        request = {'url': 'https://merchant.example/api?x=1&y=a%2Bb', 'merchant_profile': profile,
                   'buyer_limits': limits, 'require_route_binding': True}
        batch_binding.parse_request(request, enabled=False)
        cases.append({'name': profile, 'request': deepcopy(request), 'valid': True})
        for key in request:
            altered = deepcopy(request)
            altered.pop(key)
            cases.append({'name': profile+'-missing-'+key, 'request': altered, 'valid': False})
        for extra in ('need', 'probe_request', 'authorization'):
            altered = deepcopy(request)
            altered[extra] = 'not-allowed'
            cases.append({'name': profile+'-extra-'+extra, 'request': altered, 'valid': False})
        altered = deepcopy(request)
        altered['buyer_limits']['extra'] = 'not-allowed'
        cases.append({'name': profile+'-extra-limit', 'request': altered, 'valid': False})
        for key, value in limits.items():
            if key.startswith('max_'):
                for bad in (0, False, '-1', '0', '01', '1e3', str(2**64)):
                    altered = deepcopy(request)
                    altered['buyer_limits'][key] = bad
                    cases.append({'name': profile+'-'+key+'-'+repr(bad), 'request': altered, 'valid': False})
        altered = deepcopy(request)
        altered['require_route_binding'] = False
        cases.append({'name': profile+'-unbound', 'request': altered, 'valid': False})
    post = next(block for block in code.blocks if 'probe_request' in block)
    for key, value in [('url', 'https://other.example/search'), ('need', 'weather'), ('require_route_binding', False)]:
        altered = deepcopy(post)
        altered[key] = value
        cases.append({'name': 'post-invalid-'+key, 'request': altered, 'valid': False})
    altered = deepcopy(post)
    altered['probe_request']['body'] = {'query': 'x', 'mode': 'one-shot'}
    cases.append({'name': 'post-body-must-remain-raw-text', 'request': altered, 'valid': False})
    (OUT/'schema-cases.json').write_text(json.dumps(cases))
    (OUT/'mcp-input.json').write_text(json.dumps(schema_fields.route_body_schema(surface='mcp')))
    print('Exported actual fixture pages and', len(cases), 'HTTP validation cases; no paid requests.')
