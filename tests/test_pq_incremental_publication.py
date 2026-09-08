"""Incremental publication against independent C2SP/RFC9162 rebuilding."""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from live402.pq import merkle, store, tiles
from tests import test_pq_publication_writes as publication_tests


class IncrementalPublicationTests(publication_tests.PublicationWriteTests):
    def seed(self, count):
        # Bulk fixture construction is not a throughput measurement.
        bodies = [b"seed-%d" % i for i in range(count)]
        hashes = [merkle.leaf_hash(body) for body in bodies]
        ranges = {}
        for i, digest in enumerate(hashes):
            merkle.incremental_root(i + 1, digest, lambda a, b: ranges.get((a, b)),
                                    lambda a, b, h: ranges.__setitem__((a, b), h))
        conn = store._connect()
        conn.executemany("INSERT INTO leaves(idx,body,leaf_hash) VALUES(?,?,?)",
                         [(i, body, hashes[i]) for i, body in enumerate(bodies)])
        for (start, end), digest in ranges.items():
            store._store_range(conn, start, end, digest)
        conn.execute("UPDATE meta SET v=? WHERE k='size'", (str(count),))
        conn.commit()
        store.publish_up_to(count)
        return bodies

    def test_byte_equivalence_at_two_tile_carry_boundaries_without_full_log_read(self):
        for before in (254, 65534):
            with self.subTest(before=before):
                store.reset()
                bodies = self.seed(before)
                with patch.object(store, "_leaf_hashes_unlocked", side_effect=AssertionError("full log scan")):
                    for i in range(3):
                        body = b"tail-%d" % i
                        bodies.append(body)
                        store.append(body)
                        self.check_objects(bodies)

    def test_missing_historical_full_object_refuses_checkpoint_then_repairs_on_append(self):
        bodies = self.seed(513)
        conn = store._connect()
        conn.execute("DELETE FROM entry_bundles WHERE n=0 AND width=256")
        conn.execute("DELETE FROM tiles WHERE level=0 AND n=1 AND width=256")
        conn.commit()
        self.assertFalse(store.ready_to_checkpoint())
        with patch.object(store, "_publish_unlocked", wraps=store._publish_unlocked) as repair:
            store.append(b"repair-tail")
            self.assertEqual(repair.call_count, 1)
        self.check_objects(bodies + [b"repair-tail"])

    def test_fast_append_does_not_claim_historical_corruption_audit_full_repair_does(self):
        bodies = self.seed(257)
        conn = store._connect()
        conn.execute("UPDATE entry_bundles SET data=? WHERE n=0 AND width=256", (b"corrupt",))
        conn.execute("UPDATE tiles SET data=? WHERE level=0 AND n=0 AND width=256", (b"corrupt",))
        conn.commit()
        store.append(b"next")
        self.assertEqual(store.get_entry_bundle(0), b"corrupt")
        self.assertEqual(store.get_tile(0, 0), b"corrupt")
        store.publish_up_to(258)
        self.check_objects(bodies + [b"next"])

    def test_readiness_detects_each_required_object_hole_despite_surplus_rows(self):
        self.seed(513)
        conn = store._connect()
        conn.execute("INSERT INTO entry_bundles VALUES(9999,256,?)", (b"surplus",))
        conn.execute("INSERT INTO tiles VALUES(0,9999,256,?)", (b"surplus",))
        conn.commit()
        objects = [("entry_bundles", (n, w)) for n, w in tiles.bundles_required(513)]
        objects += [("tiles", (l, n, w)) for l, n, w in tiles.tiles_required(513)]
        for table, key in objects:
            where = "n=? AND width=?" if table == "entry_bundles" else "level=? AND n=? AND width=?"
            row = conn.execute("SELECT data FROM " + table + " WHERE " + where, key).fetchone()
            conn.execute("DELETE FROM " + table + " WHERE " + where, key)
            conn.commit()
            self.assertFalse(store.ready_to_checkpoint(), (table, key))
            marks = ",".join("?" for _ in (*key, row[0]))
            conn.execute("INSERT INTO " + table + " VALUES(" + marks + ")", (*key, row[0]))
            conn.commit()
            self.assertTrue(store.ready_to_checkpoint())

    def test_process_exit_during_publication_rolls_back_tail_and_rebuilds_on_reopen(self):
        store.append(b"before")
        store.close()
        child = (
            "from live402.pq import store; import os; "
            "store.tilemod.encode_hash_tile=lambda *_: os._exit(74); "
            "store.append(b'after')"
        )
        run = subprocess.run([sys.executable, "-c", child], env=os.environ.copy(),
                             cwd=str(Path(__file__).resolve().parents[1]), capture_output=True)
        self.assertEqual(run.returncode, 74, run.stderr.decode())
        with sqlite3.connect(os.environ["LIVE402_PQ_LOG_DB"]) as raw:
            self.assertEqual(raw.execute("SELECT count(*) FROM leaves").fetchone()[0], 2)
            self.assertIsNone(raw.execute("SELECT 1 FROM entry_bundles WHERE n=0 AND width=2").fetchone())
        self.assertEqual(store.size(), 2)
        self.check_objects([b"before", b"after"])
        self.assertTrue(store.append(b"after")["duplicate"])

    def test_actual_signed_receipt_does_not_rescan_the_log(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from live402.pq import events, receipt
        self.seed(1000)
        vkey = receipt.configure_signer(Ed25519PrivateKey.generate())
        self.addCleanup(receipt.configure_signer, None)
        with patch.object(store, "_leaf_hashes_unlocked", side_effect=AssertionError("receipt full log scan")):
            proof = receipt.issue(events.route_decision_event(need="synthetic", ts=1756627200))
        self.assertEqual(proof["index"], 1000)
        receipt.verify_receipt(proof, vkey)

    def test_duplicate_receipt_repairs_missing_publication_before_signing(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from live402.pq import events, receipt
        vkey = receipt.configure_signer(Ed25519PrivateKey.generate())
        self.addCleanup(receipt.configure_signer, None)
        event = events.route_decision_event(need="synthetic", ts=1756627200)
        first = receipt.issue(event)
        conn = store._connect()
        conn.execute("DELETE FROM tiles")
        conn.commit()
        self.assertFalse(store.ready_to_checkpoint())
        with patch.object(store, "publish_up_to", wraps=store.publish_up_to) as repair:
            second = receipt.issue(event)
            self.assertEqual(repair.call_count, 1)
        self.assertEqual(second, first)
        self.assertEqual(store.size(), 1)
        receipt.verify_receipt(second, vkey)
