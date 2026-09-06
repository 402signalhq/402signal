"""Production migration must not run before the runtime integration exists."""
import unittest
from types import SimpleNamespace
from scripts.replay_migrate import require_fence_aware_runtime
from live402.replay_store import StoreError


class MigrationRuntimeGate(unittest.TestCase):
    def test_missing_integration_blocks_apply(self):
        with self.assertRaises(StoreError):
            require_fence_aware_runtime(SimpleNamespace())

    def test_legacy_runtime_that_ignores_fence_is_rejected(self):
        with self.assertRaises(StoreError):
            require_fence_aware_runtime(SimpleNamespace(_selected_store_locked=lambda: None,
                                                       _identity_cutover_ready=lambda conn: True))

    def test_fence_behavior_is_exercised_not_just_claimed(self):
        def checker(conn):
            return not bool(conn.execute("SELECT 1 FROM replay_meta WHERE key='external_authority_id'").fetchone())
        require_fence_aware_runtime(SimpleNamespace(_selected_store_locked=lambda: None, _identity_cutover_ready=checker))

    def test_actual_runtime_honors_fence(self):
        from live402 import replay
        require_fence_aware_runtime(replay)
