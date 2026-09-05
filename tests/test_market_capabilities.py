"""Financial capability boundaries, ranking, and persisted taxonomy upgrades."""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import catalog, probe, pulse, shadow


class MarketCapabilityTests(unittest.TestCase):
    def test_financial_analysis_and_intelligence_alias(self):
        for text in (
            "equity market regime", "sector breadth leadership", "stock technical analysis",
            "market analysis", "market.intelligence", "market intelligence",
            "financial decision support analysis", "portfolio probabilistic returns",
            "probabilistic forward return distributions", "RSI", "MACD",
            "stock momentum signals", "ETF sector rotation", "equity screener",
            "market regime based on price and volume", "stock price forecast",
            "OHLC technical analysis", "OHLCV regime indicators",
        ):
            with self.subTest(text=text):
                self.assertEqual(catalog.capability_for_need(text), "market.analysis")

    def test_representative_provider_metadata(self):
        # Endpoint contracts distinguish price data from downstream analytical uses.
        cases = (
            ("market_regime_latest", "Current market regime classification.", "market.analysis"),
            ("breadth_sector_latest", "Latest breadth across industry groupings.", "market.analysis"),
            ("leadership_summary_latest", "Leadership summary across sectors.", "market.analysis"),
            ("stim_latest", "Probabilistic forward return distributions for one instrument.", "market.analysis"),
            ("evaluate_symbol", "Evaluate trend context against the live market regime.", "market.analysis"),
            ("indicators_latest", "Latest weekly equity trend indicator row for one instrument.", "market.analysis"),
            ("prices_latest", "Weekly price context to pair with equity trend indicator and signal analysis.", "market.price"),
            ("ai_tools", "Discoverable tools, workflows, and pricing model.", "unknown"),
        )
        for name, description, expected in cases:
            with self.subTest(name=name):
                row = {"toolName": name, "description": description}
                self.assertEqual(catalog.classify_capability(row)[0], expected)

    def test_prices_keep_their_category(self):
        for text in (
            "stock price", "market ticker", "equity quotes", "historical OHLCV candles",
            "OHLC", "OHLCV", "trading price feed", "crypto prices", "forex quote", "DEX swap quote", "TVL",
        ):
            with self.subTest(text=text):
                self.assertEqual(catalog.capability_for_need(text), "market.price")

    def test_ambiguous_or_nonfinancial_language_is_not_analysis(self):
        for text in (
            "analysis", "intelligence", "signals", "leadership", "breadth", "regime",
            "technical analysis", "political regime analysis", "team leadership analytics",
            "network signal analysis", "market", "trading", "stock data",
            "weather climate analysis", "weather forecast", "web search analysis",
            "financial market analysis and weather forecast", "market analysis and email",
        ):
            with self.subTest(text=text):
                self.assertNotEqual(catalog.capability_for_need(text), "market.analysis")
        self.assertEqual(catalog.capability_for_need("weather forecast"), "travel.weather")
        self.assertEqual(catalog.capability_for_need("web search analysis"), "search.web")

    def test_evidence_precedence_and_generic_tags(self):
        row = {"tags": ["market", "trading"], "description": "equity regime analysis"}
        self.assertEqual(catalog.classify_capability(row), ("market.analysis", "description"))
        row["tags"] = ["stock", "quotes"]
        self.assertEqual(catalog.classify_capability(row), ("market.price", "tags"))
        row = {"toolName": "sector_breadth", "description": "stock quotes"}
        self.assertEqual(catalog.classify_capability(row), ("market.analysis", "toolName"))
        row = {"tags": ["leadership"], "serviceName": "Stock API"}
        self.assertEqual(catalog.classify_capability(row), ("unknown", "unknown"))

    def test_url_fallback_requires_distinctive_financial_evidence(self):
        for url in (
            "https://api.example/v1/market/regime/latest",
            "https://api.example/v1/breadth/sector/latest",
            "https://api.example/v1/rsi",
        ):
            self.assertEqual(catalog.classify_capability({"url": url}), ("market.analysis", "url"))
        for url in (
            "https://api.example/v1/analysis", "https://api.example/v1/leadership",
            "https://api.example/v1/market", "https://api.example/v1/trading",
        ):
            self.assertEqual(catalog.classify_capability({"url": url}), ("unknown", "unknown"))

    def test_specific_need_ranks_matching_analysis_above_other_analysis_and_prices(self):
        def item(path, description):
            return catalog.slim_item({"url": "https://api.example/" + path,
                                      "description": description}, "base")
        breadth = item("a", "sector breadth leadership")
        regime = item("b", "equity market regime")
        price = item("c", "market price quote")
        for need, winner in (("sector breadth leadership", breadth),
                             ("equity market regime", regime), ("market price quote", price)):
            with self.subTest(need=need):
                self.assertEqual(probe.rank_resources(need, [price, regime, breadth])[0]["url"], winner["url"])
        self.assertGreater(probe.score_need("market intelligence", regime),
                           probe.score_need("market intelligence", price))

    def test_pulse_uses_one_market_theme(self):
        for text in ("sector breadth leadership", "RSI", "stock quote", "market regime"):
            row = catalog.slim_item({"url": "https://api.example/a", "description": text}, "base")
            self.assertEqual(pulse.theme_id_for(row, row["url"]), "market")
        self.assertNotIn("market.analysis", pulse.THEME_ORDER)


class StoredCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "catalog.sqlite")
        self.env = patch.dict(os.environ, {"LIVE402_CATALOG_DB": self.db})
        self.env.start()
        shadow.reset()

    def tearDown(self):
        shadow.reset()
        self.env.stop()
        self.temp.cleanup()

    def seed_legacy(self, url="https://api.example/a", description="equity market regime"):
        row = catalog.slim_item({"url": url, "description": description,
                                "accepts": [{"network": "base", "amount": "1000", "payTo": "0xabc"}]}, "base")
        result = shadow.upsert_item(row, source="cdp", ts=1700000000)
        self.assertIsNotNone(result["id"])
        shadow.mark_verified(url, ts=1700000010)
        # Simulate the old classifier and index, not a new upstream observation.
        with shadow._lock:
            conn = shadow._connect()
            cur = conn.cursor()
            cur.execute("UPDATE resources SET capability = 'market.price', capability_version = 0 WHERE id = ?",
                        (result["id"],))
            fields = dict(cur.execute("SELECT * FROM resources WHERE id = ?", (result["id"],)).fetchone())
            shadow._sync_fts(cur, result["id"], fields)
            conn.commit()
        return result["id"]

    def test_legacy_read_immediately_uses_new_label_without_changing_clocks(self):
        url = "https://api.example/a"
        self.seed_legacy(url)
        before = shadow.clocks(url)
        item = shadow.get_resource(url)
        self.assertEqual(item["capability"], "market.analysis")
        self.assertEqual(shadow.fts_search("regime")[0]["capability"], "market.analysis")
        self.assertEqual(shadow.clocks(url), before)
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("SELECT capability_version FROM resources").fetchone()[0], 0)

    def test_bounded_reclassification_preserves_evidence_and_reindexes(self):
        for n in range(3):
            self.seed_legacy("https://api.example/" + str(n))
        with sqlite3.connect(self.db) as conn:
            before = {table: conn.execute("SELECT * FROM " + table).fetchall()
                      for table in ("accept_claims", "resource_sources", "claim_events", "source_state")}
            clocks = conn.execute("SELECT first_seen,last_seen,last_fetched,last_verified,last_searched,last_routed,status FROM resources").fetchall()
        self.assertEqual(shadow.reclassify_capabilities(limit=2), 2)
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM resources WHERE capability_version = 0").fetchone()[0], 1)
        self.assertEqual(shadow.reclassify_capabilities(limit=2), 1)
        self.assertEqual(shadow.reclassify_capabilities(), 0)
        self.assertEqual(len(shadow.fts_search("analysis")), 3)
        with sqlite3.connect(self.db) as conn:
            for table, rows in before.items():
                self.assertEqual(conn.execute("SELECT * FROM " + table).fetchall(), rows)
            self.assertEqual(conn.execute("SELECT first_seen,last_seen,last_fetched,last_verified,last_searched,last_routed,status FROM resources").fetchall(), clocks)
            self.assertEqual(conn.execute("SELECT DISTINCT capability FROM resources").fetchall(), [("market.analysis",)])

    def test_failed_index_update_rolls_back_version_and_label(self):
        self.seed_legacy()
        with patch("live402.shadow._sync_fts", side_effect=sqlite3.OperationalError("test failure")):
            with self.assertRaises(sqlite3.OperationalError):
                shadow.reclassify_capabilities()
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("SELECT capability,capability_version FROM resources").fetchone(), ("market.price", 0))
        self.assertEqual(shadow.reclassify_capabilities(), 1)
        self.assertEqual(len(shadow.fts_search("analysis")), 1)

    def test_old_schema_upgrades_without_dropping_records(self):
        legacy_schema = shadow._SCHEMA.replace("    capability_version INTEGER NOT NULL DEFAULT 0,\n", "").replace("    tool_name TEXT,\n", "")
        with sqlite3.connect(self.db) as conn:
            conn.executescript(legacy_schema)
            conn.execute("INSERT INTO resources(canonical_url,description,capability,first_seen,last_seen) VALUES (?,?,?,?,?)",
                         ("https://api.example/a", "sector breadth", "market.price", 10, 20))
        self.assertEqual(shadow.get_resource("https://api.example/a")["capability"], "market.analysis")
        self.assertEqual(shadow.reclassify_capabilities(), 1)
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("SELECT first_seen,last_seen FROM resources").fetchone(), (10, 20))

    def test_tool_name_survives_storage_and_future_reclassification(self):
        row = catalog.slim_item({"url": "https://api.example/a", "toolName": "sector_breadth"}, "base")
        shadow.upsert_item(row, source="cdp")
        self.assertEqual(shadow.get_resource(row["url"])["toolName"], "sector_breadth")
        with patch("live402.catalog.CAPABILITY_VERSION", catalog.CAPABILITY_VERSION + 1):
            self.assertEqual(shadow.reclassify_capabilities(), 1)
            self.assertEqual(shadow.get_resource(row["url"])["capability"], "market.analysis")

    def test_synonym_search_keeps_one_request_per_rail_and_local_results(self):
        self.seed_legacy()
        shadow.reclassify_capabilities()
        calls = []
        def payload(url, *args, **kwargs):
            calls.append(url)
            self.assertEqual(parse_qs(urlparse(url).query)["query"], ["market analysis"])
            return {"resources": [], "partialResults": False}
        with patch("live402.catalog.fixtures.fixture_mode", return_value=False), patch(
            "live402.probe._fetch_catalog_payload", side_effect=payload
        ):
            result = catalog.query_for_need("market intelligence")
        self.assertEqual(len(calls), 3)
        self.assertEqual(result["items"][0]["capability"], "market.analysis")
        self.assertLessEqual(len(result["items"]), catalog.WORKING_SET_HARD_CAP)

    def test_reclassification_does_not_starve_refresh(self):
        self.seed_legacy()
        with patch("live402.catalog.fixtures.fixture_mode", return_value=False), patch(
            "live402.catalog._refresh_disabled", return_value=False
        ), patch("live402.shadow.due_valued", return_value=[{"url": "https://api.example/a", "reason": "recent_search"}]), patch(
            "live402.catalog._refresh_url_claims"
        ) as refresh:
            self.assertEqual(catalog.trickle_once(), "recent_search")
            refresh.assert_called_once_with("https://api.example/a")
        self.assertEqual(shadow.reclassify_capabilities(), 0)

    def test_reclassification_failure_does_not_block_claim_refresh(self):
        with patch("live402.catalog.fixtures.fixture_mode", return_value=False), patch(
            "live402.catalog._refresh_disabled", return_value=False
        ), patch("live402.shadow.reclassify_capabilities", side_effect=sqlite3.OperationalError("busy")), patch(
            "live402.shadow.due_valued", return_value=[]
        ), patch("live402.shadow.next_cold_source", return_value="cdp"), patch(
            "live402.catalog.ingest_one_page"
        ) as ingest:
            self.assertEqual(catalog.trickle_once(), "cold")
            ingest.assert_called_once_with("cdp")

    def test_large_requested_batch_is_capped_and_indexed(self):
        rows = [catalog.slim_item({"url": f"https://api.example/{n}", "description": "market regime"}, "base")
                for n in range(shadow.CAPABILITY_BATCH + 1)]
        shadow.upsert_items(rows, source="cdp")
        with shadow._lock:
            conn = shadow._connect()
            conn.execute("UPDATE resources SET capability_version = 0")
            conn.commit()
            plan = conn.execute(
                "EXPLAIN QUERY PLAN SELECT * FROM resources WHERE capability_version < ? ORDER BY capability_version, id LIMIT ?",
                (catalog.CAPABILITY_VERSION, shadow.CAPABILITY_BATCH),
            ).fetchall()
            self.assertIn("resources_capability_version", " ".join(str(row[3]) for row in plan))
        self.assertEqual(shadow.reclassify_capabilities(limit=100000), shadow.CAPABILITY_BATCH)
        self.assertEqual(shadow.reclassify_capabilities(), 1)

    def test_retired_rows_stay_retired_and_prices_stay_prices(self):
        self.seed_legacy(description="stock price quote")
        with shadow._lock:
            conn = shadow._connect()
            conn.execute("UPDATE resources SET status = 'retired', retired_at = 1700000020")
            conn.commit()
        self.assertEqual(shadow.reclassify_capabilities(), 1)
        self.assertEqual(shadow.get_resource("https://api.example/a")["capability"], "market.price")
        self.assertEqual(shadow.fts_search("price"), [])
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("SELECT status,retired_at FROM resources").fetchone(), ("retired", 1700000020))

    def test_reclassification_failure_warning_is_coarse_and_rate_limited(self):
        with patch("live402.catalog.fixtures.fixture_mode", return_value=False), patch(
            "live402.catalog._refresh_disabled", return_value=False
        ), patch("live402.shadow.reclassify_capabilities", side_effect=sqlite3.OperationalError("private /data/path seller secret")), patch(
            "live402.shadow.due_valued", return_value=[]
        ), patch("live402.shadow.next_cold_source", return_value="cdp"), patch(
            "live402.catalog.ingest_one_page"
        ) as ingest, patch("live402.catalog._last_reclassification_warning", None), patch(
            "live402.catalog.time.monotonic", side_effect=[10, 11, 70]
        ), self.assertLogs("live402.catalog", level="WARNING") as logs:
            for _ in range(3):
                self.assertEqual(catalog.trickle_once(), "cold")
            self.assertEqual(ingest.call_count, 3)
        self.assertEqual([record.getMessage() for record in logs.records],
                         ["catalog_reclassification_failed"] * 2)
        self.assertNotIn("private", " ".join(logs.output))

    def test_capability_only_retrieval_catches_up_after_reindex(self):
        self.seed_legacy(description="equity regime")
        # A corrected label on a returned row cannot add that row to an FTS hit set.
        self.assertEqual(shadow.fts_search("analysis"), [])
        self.assertEqual(shadow.fts_search("equity regime")[0]["capability"], "market.analysis")
        self.assertEqual(shadow.reclassify_capabilities(), 1)
        self.assertEqual(shadow.fts_search("analysis")[0]["capability"], "market.analysis")
