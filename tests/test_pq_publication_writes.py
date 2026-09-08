"""Publication stays durable and byte-identical without rewriting old objects."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from live402.pq import merkle, store, tiles


class PublicationWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, LIVE402_FIXTURE="1",
                              LIVE402_PQ_LOG_DB=self.tmp.name + "/pq.sqlite")
        self.env.start()
        self.addCleanup(self.env.stop)
        store.close()
        self.addCleanup(store.close)

    def check_objects(self, bodies):
        hashes = [merkle.leaf_hash(body) for body in bodies]
        self.assertEqual(store.root(), merkle.mth_from_leaf_hashes(hashes))
        for n, width in tiles.bundles_required(len(bodies)):
            self.assertEqual(store.get_entry_bundle(n, width),
                             tiles.encode_entry_bundle(bodies[n * 256:n * 256 + width]))
        for level, n, width in tiles.tiles_required(len(bodies)):
            self.assertEqual(store.get_tile(level, n, width), tiles.encode_hash_tile(
                tiles.tile_hashes_for_level(hashes, level, n, width)))
        self.assertTrue(store.ready_to_checkpoint())

    def test_republish_is_read_only_for_unchanged_materialized_objects(self):
        bodies = [b"entry-%04d" % i for i in range(257)]
        for body in bodies:
            store.append(body)
        self.check_objects(bodies)
        conn = store._connect()
        before = conn.total_changes
        store.publish_up_to(len(bodies))
        self.assertEqual(conn.total_changes, before,
                         "identical C2SP publication must not rewrite durable objects")
        self.check_objects(bodies)

    def test_missing_and_corrupt_derived_objects_are_still_repaired(self):
        bodies = [b"alpha", b"beta", b"gamma"]
        for body in bodies:
            store.append(body)
        conn = store._connect()
        conn.execute("UPDATE entry_bundles SET data=? WHERE n=0 AND width=3", (b"bad",))
        conn.execute("DELETE FROM tiles WHERE level=0 AND n=0 AND width=3")
        conn.commit()
        store.publish_up_to(3)
        self.check_objects(bodies)

    def test_concurrent_duplicate_append_preserves_one_index_and_all_objects(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: store.append(b"same"), range(24)))
        self.assertEqual({x["idx"] for x in results}, {0})
        self.assertEqual(sum(not x["duplicate"] for x in results), 1)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i: store.append(b"different-%d" % i), range(32)))
        bodies = [store.leaf_at(i)["body"] for i in range(store.size())]
        self.check_objects(bodies)

    def test_process_exit_after_leaf_commit_recovers_publication_without_new_leaf(self):
        store.append(b"before")
        store.close()
        child = "from live402.pq import store; import os; store.install_after_durable_hook(lambda *_: os._exit(73)); store.append(b'after')"
        run = subprocess.run([sys.executable, "-c", child], env=os.environ.copy(),
                             cwd=str(Path(__file__).resolve().parents[1]), capture_output=True)
        self.assertEqual(run.returncode, 73, run.stderr.decode())
        self.assertEqual(store.size(), 2)
        self.check_objects([b"before", b"after"])
        recovered = store.append(b"after")
        self.assertTrue(recovered["duplicate"])
        self.assertEqual(recovered["idx"], 1)
        self.assertEqual(store.size(), 2)
