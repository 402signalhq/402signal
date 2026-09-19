"""Archived public wire conformance; no live network or signature forgery."""
import base64
import copy
import hashlib
import unittest
from pathlib import Path
from signal_trust import ORIGIN_MAINNET, anchor, algo_tx

TXID = "HIQM6VWDMUWHUTQG7SZF2QW3XYFY4HRLRK3BV22CQLENDRB7AKJQ"
ADDRESS = "GVIAG3YMJ7OLJ3JAUBNI2YP5JCQQCQYWN25UAGLC2BTPOBUL3ZZTILIMWU"
ROOT = "9b43b8903c007e56ad4dba883cf17825e36e22e2efe046102b330bc504e3fbd9"
FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/pq_falcon_wire/tree4_signedtxn.b64"

class PublicAnchorTests(unittest.TestCase):
    def setUp(self):
        self.wire = base64.b64decode(FIXTURE.read_text())
        self.decoded = anchor.decode_chain_txn(algo_tx.msgpack_decode(self.wire))
        # SignedTxn bytes alone do not attest confirmation; these two public
        # metadata values come from the historical fixture's recorded readback.
        self.decoded.update(txid=TXID, confirmed_round=64663849)
        self.expected = dict(expected_origin=ORIGIN_MAINNET, expected_size=4,
            expected_root=ROOT, expected_address=ADDRESS, expected_txid=TXID,
            expected_network="mainnet")

    def test_archived_wire_txid_and_checkpoint_match(self):
        self.assertEqual(hashlib.sha256(self.wire).hexdigest(), "566db3b3efd9db449e5f62e36b7986bcfa87e7875cc3ae1b53605063ae570af3")
        self.assertEqual(algo_tx.txid_from_signed(self.wire), TXID)
        result = anchor.verify_fetched_anchor(self.decoded, **self.expected)
        self.assertEqual(result["reconstructed_txid"], TXID)
        self.assertEqual(result["indexer_missing_fields"], [])
        self.assertEqual(result["tree_size"], 4)

    def test_missing_explicit_network_and_mutated_pins_reject(self):
        for field, value in [("expected_network", None), ("expected_network", "testnet"),
                ("expected_size", 5), ("expected_root", "00" * 32),
                ("expected_origin", "another/log"), ("expected_txid", "A" * 52)]:
            with self.subTest(field=field, value=value), self.assertRaises(anchor.AnchorError):
                anchor.verify_fetched_anchor(self.decoded, **{**self.expected, field: value})

    def test_unconfirmed_or_changed_transaction_rejects(self):
        for field, value in [("confirmed_round", 0), ("amount", 1), ("fee", 3001),
                ("receiver", "A" * 58), ("auth_addr", "A" * 58),
                ("pq_auth", b"present"), ("group", b"x")]:
            with self.subTest(field=field), self.assertRaises(anchor.AnchorError):
                anchor.verify_fetched_anchor({**self.decoded, field: value}, **self.expected)

    def test_checkpoint_note_round_trip(self):
        note = self.decoded["note"]
        body = anchor.c2sp_body_from_note(note, ORIGIN_MAINNET)
        self.assertEqual(anchor.note_from_checkpoint_body(body), note)
        with self.assertRaises(anchor.AnchorError):
            anchor.c2sp_body_from_note(note, "another/log")

if __name__ == "__main__":
    unittest.main()
