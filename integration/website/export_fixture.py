"""Export actual server-rendered pages and schemas in a disposable fixture.

Only fixed loopback GET requests are made. No production configuration, wallet,
payment header, signing account, paid routing request or external URL is used.
"""
from __future__ import annotations
import base64
from copy import deepcopy
import hashlib
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from integration.website.doc_examples import CodeBlocks

OUT = ROOT / 'website-evidence'
OUT.mkdir(exist_ok=True)
os.environ['LIVE402_FIXTURE'] = '1'
os.environ.pop('LOCAL_FREE', None)


def algo_address(byte):
    raw = bytes([byte]) * 32
    return base64.b32encode(raw + hashlib.new('sha512_256', raw).digest()[-4:]).decode().rstrip('=')


with tempfile.TemporaryDirectory(prefix='website-fixture-') as directory:
    for key, filename in [('LIVE402_PQ_LOG_DB', 'pq-log-mainnet.sqlite'), ('LIVE402_HISTORY_DB', 'history.sqlite'),
                          ('LIVE402_CATALOG_DB', 'catalog.sqlite'), ('LIVE402_REPLAY_DB', 'replay.sqlite')]:
        os.environ[key] = str(Path(directory) / filename)
    os.environ['LIVE402_PQ_FALCON_NETWORK'] = 'mainnet'
    os.environ['LIVE402_PQ_LOG_EPOCH'] = 'mainnet-v1'
    os.environ['LIVE402_PQ_LOG_ORIGIN'] = '402signal.com/pq/log/mainnet-v1'
    from live402.server import Handler, CSP
    from live402 import schema_fields, batch_binding
    from live402.batch_profiles import base, solana, algorand_generic as algo
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def dashboard_snapshot(prefix):
        return {
            'updated_at': '2026-09-08T12:00:00Z',
            'chains': {chain: {
                'source': {'ok': True, 'host': 'synthetic catalog'},
                'samples': [
                    {'label': prefix + ' weather', 'need': 'weather', 'price': '$0.001',
                     'url': 'https://seller.example/weather'},
                    {'label': prefix + ' detailed multi-region weather forecast with hourly precipitation and temperature observations',
                     'need': 'forecast', 'price': 'unknown', 'url': 'https://seller.example/forecast'},
                    {'label': prefix + ' ' + 'LongUnbrokenSyntheticLabel' * 4,
                     'need': 'search', 'price': '$0.020',
                     'url': 'https://' + 'long-synthetic-host-' * 3 + 'seller.example/search'},
                ],
            } for chain in ('base', 'solana', 'algorand')},
        }

    (OUT / 'dashboard-refresh.json').write_text(json.dumps(dashboard_snapshot('Updated')))
    exports = {}
    dashboard_fixture = patch('live402.pulse.get_pulse', return_value=dashboard_snapshot('Initial'))
    dashboard_fixture.start()
    try:
        for path, name in [('/transparency', 'transparency.html'), ('/dashboard', 'dashboard.html'),
                           ('/route', 'route.html'), ('/openapi.json', 'openapi.json'),
                           ('/mcp.json', 'mcp.json'), ('/pulse', 'pulse.json')] + [('/developers/' + slug, 'recipe-' + slug + '.html') for slug in __import__('live402.developer_guides', fromlist=['GUIDES']).GUIDES]:
            connection = HTTPConnection('127.0.0.1', server.server_address[1], timeout=10)
            connection.request('GET', path, headers={'Accept': 'text/html' if name.endswith('.html') else 'application/json'})
            response = connection.getresponse()
            raw = response.read()
            assert response.status == 200, (path, response.status)
            if name.endswith('.html'):
                assert response.getheader('Content-Security-Policy') == CSP
            connection.close()
            (OUT / name).write_bytes(raw)
            exports[path] = name
        # Synthetic read-model records only, not signed or broadcast checkpoints.
        from live402.pq import store, ORIGIN_MAINNET
        for leaf in (b'website-one', b'website-two', b'website-three'):
            store.append(leaf)
        for size, txid, block, at in ((1, 'B' * 52, 100, 1788868800),
                                      (3, 'C' * 52, 200, 1788868860)):
            store.save_confirmed_checkpoint(tree_size=size, origin=ORIGIN_MAINNET,
                root=store.root(size), txid=txid, confirmed_round=block, at=at,
                network='mainnet', genesis_id='mainnet-v1.0')
        connection = HTTPConnection('127.0.0.1', server.server_address[1], timeout=10)
        connection.request('GET', '/transparency', headers={'Accept': 'text/html'})
        response = connection.getresponse()
        assert response.status == 200
        assert response.getheader('Content-Security-Policy') == CSP
        (OUT / 'transparency-confirmed.html').write_bytes(response.read())
        connection.close()
        exports['/transparency-confirmed'] = 'transparency-confirmed.html'
    finally:
        dashboard_fixture.stop()
        server.shutdown()
        server.server_close()
    (OUT / 'exports.json').write_text(json.dumps(exports))

    # Qualify what the current guide actually publishes, including curl JSON.
    # This extracts text; it never executes the documented commands.
    code = CodeBlocks()
    code.feed((ROOT / 'live402/static/developers.html').read_text())
    assert code.blocks, 'The developer guide must publish at least one real JSON request'
    cases = [{'name': 'documentation-' + str(i), 'request': block, 'valid': True} for i, block in enumerate(code.blocks)]
    cases += [{'name': 'ordinary', 'request': {'need': 'weather', 'require_route_binding': True}, 'valid': True},
              {'name': 'unknown-top-key', 'request': {'need': 'weather', 'privateKey': 'NOT_A_KEY'}, 'valid': False}]
    profiles = {
        'base-x402-batch-v1': {'network': base.NETWORK, 'asset': base.ASSET, 'recipient': '0x' + '11' * 20,
            'receiver_authorizer': base.AUTHORIZER, 'withdraw_delay_seconds': 900,
            'max_call_amount_atomic': '1000', 'max_cumulative_amount_atomic': '2000', 'max_capital_atomic': '4000'},
        'solana-mpp-session-v1': {'network': solana.NETWORK, 'asset': solana.ASSET, 'recipient': solana.ASSET,
            'operator': solana.PROGRAM, 'program_id': solana.PROGRAM, 'max_session_cap_atomic': '4000'},
        'algorand-atomic-two-item-v1': {'network': algo.NETWORK, 'asset': algo.ASSET,
            'recipient': algo_address(1), 'fee_payer': algo_address(2), 'max_item_amount_atomic': '1000',
            'max_total_amount_atomic': '2000', 'max_sponsor_fee_micro_algo': '15000', 'job_hashes': ['a' * 64, 'b' * 64]},
    }
    for profile, limits in profiles.items():
        request = {'url': 'https://merchant.example/api?x=1&y=a%2Bb', 'merchant_profile': profile,
                   'buyer_limits': limits, 'require_route_binding': True}
        batch_binding.parse_request(request, enabled=False)
        cases.append({'name': profile, 'request': deepcopy(request), 'valid': True})
        for key in request:
            altered = deepcopy(request)
            altered.pop(key)
            cases.append({'name': profile + '-missing-' + key, 'request': altered, 'valid': False})
        for extra in ('need', 'probe_request', 'authorization'):
            altered = deepcopy(request)
            altered[extra] = 'not-allowed'
            cases.append({'name': profile + '-extra-' + extra, 'request': altered, 'valid': False})
        altered = deepcopy(request)
        altered['buyer_limits']['extra'] = 'not-allowed'
        cases.append({'name': profile + '-extra-limit', 'request': altered, 'valid': False})
        for key, value in limits.items():
            if key.startswith('max_'):
                for bad in (0, False, '-1', '0', '01', '1e3', str(2 ** 64)):
                    altered = deepcopy(request)
                    altered['buyer_limits'][key] = bad
                    cases.append({'name': profile + '-' + key + '-' + repr(bad), 'request': altered, 'valid': False})
        altered = deepcopy(request)
        altered['require_route_binding'] = False
        cases.append({'name': profile + '-unbound', 'request': altered, 'valid': False})

    # The specialized POST example is linked from the task guide rather than
    # repeated in the quickstart. Retain its positive and negative contract cases.
    post = next((block for block in code.blocks if 'probe_request' in block), None)
    if post is None:
        post = {'url': 'https://parallelmpp.dev/api/search', 'networks': ['base'],
                'max_price_usd': 0.01, 'require_invocable': True, 'require_route_binding': True,
                'probe_request': {'profile': 'parallel-search-json-v1', 'method': 'POST',
                                  'body': '{"query":"x402 payment protocol","mode":"one-shot"}'}}
        cases.append({'name': 'bounded-post-contract-fixture', 'request': deepcopy(post), 'valid': True})
    for key, value in [('url', 'https://other.example/search'), ('need', 'weather'), ('require_route_binding', False)]:
        altered = deepcopy(post)
        altered[key] = value
        cases.append({'name': 'post-invalid-' + key, 'request': altered, 'valid': False})
    altered = deepcopy(post)
    altered['probe_request']['body'] = {'query': 'x', 'mode': 'one-shot'}
    cases.append({'name': 'post-body-must-remain-raw-text', 'request': altered, 'valid': False})
    (OUT / 'schema-cases.json').write_text(json.dumps(cases))
    (OUT / 'mcp-input.json').write_text(json.dumps(schema_fields.route_body_schema(surface='mcp')))
    print('Exported actual fixture pages and', len(cases), 'HTTP validation cases; no paid requests.')
