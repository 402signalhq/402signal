"""Private retrieval and bounded storage regressions; synthetic authorizations only."""
import copy
import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

from live402 import facilitator, replay
from live402.route import handle_route
from test_pay_replay import _payload, _headers_for, _weather_body, _fake_facilitator

URL = 'https://402signal.com/route'


class PrivateReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, LIVE402_FIXTURE='1', LOCAL_FREE='', CDP_ACCESS_TOKEN='test-fixture-token',
                              LIVE402_REPLAY_DB=self.temp.name + '/replay.sqlite')
        self.env.start()
        replay.reset_memory()

    def tearDown(self):
        replay.reset_memory()
        self.env.stop()
        self.temp.cleanup()

    def test_private_key_and_entire_request_required_across_restart(self):
        payload = _payload('privacy')
        headers = _headers_for(payload)
        body = _weather_body()
        with patch('live402.facilitator.post_json', side_effect=_fake_facilitator):
            first = handle_route(body, headers, URL)
        self.assertEqual(first[0], 200)
        for restart in (False, True):
            if restart:
                replay.reset_memory()
            public = copy.deepcopy(payload)
            public['payload'].pop('signature')
            absent = _headers_for(public)
            absent.pop('Replay-Key')
            wrong = _headers_for(payload)
            wrong['Replay-Key'] = 'b2' * 32
            with patch('live402.facilitator.verify') as verify, patch('live402.facilitator.settle') as settle:
                for request, credential in [(body, absent), (body, wrong),
                    ({**body, 'need': 'different private need'}, headers),
                    ({**body, 'max_price_usd': 0}, headers),
                    ({**body, 'require_route_binding': True}, headers)]:
                    result = handle_route(request, credential, URL)
                    self.assertEqual(result[0], 503)
                    self.assertNotIn('pq_trust', result[1])
                    self.assertNotIn('url', result[1])
                original = handle_route(dict(reversed(list(body.items()))), headers, URL)
                self.assertEqual(original, first)
                verify.assert_not_called()
                settle.assert_not_called()

    def test_no_key_executes_once_but_never_retrieves(self):
        headers = _headers_for(_payload('no-key'))
        headers.pop('Replay-Key')
        with patch('live402.facilitator.post_json', side_effect=_fake_facilitator):
            self.assertEqual(handle_route(_weather_body(), headers, URL)[0], 200)
        with patch('live402.facilitator.settle') as settle:
            self.assertEqual(handle_route(_weather_body(), headers, URL)[0], 503)
            settle.assert_not_called()

    def test_invalid_authorizations_create_no_durable_rows(self):
        with patch('live402.facilitator.verify', return_value=facilitator.FacilitatorResult(ok=False)), patch('live402.facilitator.settle') as settle:
            for i in range(20):
                self.assertEqual(handle_route(_weather_body(), _headers_for(_payload(str(i))), URL)[0], 402)
            settle.assert_not_called()
        self.assertEqual(replay._connect().execute('SELECT count(*) FROM settle_ledger').fetchone()[0], 0)
        self.assertLessEqual(len(replay._completed), replay.MAX_COMPLETED)

    def test_expired_output_removed_without_reopening_settlement(self):
        headers = _headers_for(_payload('expiry'))
        with patch('live402.facilitator.post_json', side_effect=_fake_facilitator):
            self.assertEqual(handle_route(_weather_body(), headers, URL)[0], 200)
        replay.reset_memory()
        with patch('live402.replay.time.time', return_value=time.time() + 121), patch('live402.facilitator.settle') as settle:
            self.assertEqual(handle_route(_weather_body(), headers, URL)[0], 503)
            self.assertEqual(replay.begin('fresh-auth', scope='private')[0], 'run')
            settle.assert_not_called()
        rows = replay._connect().execute('SELECT state, outcome_json FROM settle_ledger').fetchall()
        self.assertIn(('settled', None), rows)

    def test_capacity_does_not_block_existing_private_retrieval(self):
        headers = _headers_for(_payload('capacity'))
        with patch('live402.facilitator.post_json', side_effect=_fake_facilitator):
            first = handle_route(_weather_body(), headers, URL)
        replay.reset_memory()
        with patch('live402.replay.MAX_LEDGER_ROWS', 1), patch('live402.facilitator.settle') as settle:
            self.assertEqual(handle_route(_weather_body(), headers, URL), first)
            self.assertEqual(replay.begin('fresh-auth', scope='private')[0], 'reject')
            settle.assert_not_called()


if __name__ == '__main__':
    unittest.main()
