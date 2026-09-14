"""A probe row's rail is the observed option's, never the catalog listing's.

Background: api.syraa.fun/news is listed by CDP, GoPlausible and PayAI on Base, Algorand
and Solana. Its live challenge answered with Solana terms first, so the recorded
recipient was the Solana address, but the routed path stamped the row with the listing's
rail (Algorand). The report then printed "Algorand" next to a Solana recipient.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("LIVE402_FIXTURE", "1")

from live402 import history, maintenance, payment, probe

URL = "https://seller.example/news"
SOLANA_PAYTO = "53JhuF8bgxvUQ59nDG6kWs4awUQYCS3wswQmUsV5uC7t"
ALGO_PAYTO = "IQ5SGZDKKOXUKNNX4JH5MXZTVUWZM5SXGD5LIG7FXASOAVFZ2QBMJLSFII"
BASE_PAYTO = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca"


def accept(network, asset, pay_to, amount="5000"):
    return {"scheme": "exact", "network": network, "asset": asset, "amount": amount,
            "payTo": pay_to, "maxTimeoutSeconds": 60}


SOLANA_ACCEPT = accept(payment.SOLANA_MAINNET, payment.USDC_SOLANA_MINT, SOLANA_PAYTO)
ALGO_ACCEPT = accept(payment.ALGORAND_MAINNET, payment.USDC_ALGORAND_ASA, ALGO_PAYTO)
BASE_ACCEPT = accept(payment.BASE_CAIP2, payment.USDC_BASE, BASE_PAYTO)


def live_snap(pay_to, rail, **extra):
    snap = {"live": True, "status": 402, "latency_ms": 5, "has_402_challenge": True,
            "payTo": pay_to, "rail": rail, "probed_at": probe.now_iso()}
    snap.update(extra)
    return snap


class TempHistory(unittest.TestCase):
    def setUp(self):
        self._prev = os.environ.get("LIVE402_HISTORY_DB")
        fd, self._path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.environ["LIVE402_HISTORY_DB"] = self._path
        history.reset()

    def tearDown(self):
        history.reset()
        if self._prev is None:
            os.environ.pop("LIVE402_HISTORY_DB", None)
        else:
            os.environ["LIVE402_HISTORY_DB"] = self._prev
        for p in (self._path, self._path + "-wal", self._path + "-shm"):
            try:
                os.remove(p)
            except OSError:
                pass

    def db(self):
        return sqlite3.connect(self._path)


class ObservedRailTests(TempHistory):
    def test_envelope_rail_is_the_first_option_with_a_recipient(self):
        env = {"x402Version": 2, "accepts": [SOLANA_ACCEPT, BASE_ACCEPT]}
        self.assertEqual(probe._observed_rail_from_envelope(env), "solana")
        thin_then_algo = {"x402Version": 2, "accepts": [{"scheme": "exact", "network": payment.BASE_CAIP2}, ALGO_ACCEPT]}
        self.assertEqual(probe._observed_rail_from_envelope(thin_then_algo), "algorand")
        self.assertIsNone(probe._observed_rail_from_envelope({"accepts": []}))
        self.assertIsNone(probe._observed_rail_from_envelope(None))

    def test_probe_result_keeps_the_observed_rail_over_the_listing_rail(self):
        result = probe.health_from_probe(URL, live_snap(SOLANA_PAYTO, "solana"))
        self.assertEqual(result["rail"], "solana")
        item = {"url": URL, "_rail": "algorand", "accepts": [BASE_ACCEPT, ALGO_ACCEPT, SOLANA_ACCEPT]}
        routed = probe._finalize_routed_probe(dict(result), item, "news")
        self.assertEqual(routed["rail"], "solana")
        # The claim is read from the accept on the observed rail, so claimed and observed compare like for like.
        self.assertEqual(routed["claimed"]["payTo"], SOLANA_PAYTO)
        self.assertFalse(routed["payTo_changed"])
        self.assertEqual(history._claimed_rail(routed["claimed"]), "solana")
        # Nothing observed: the listing's rail still labels the result.
        miss = probe.health_from_probe(URL, {"live": False, "status": None, "miss_reason": "no_402_envelope",
                                             "probed_at": probe.now_iso()})
        self.assertEqual(probe._finalize_routed_probe(miss, item, "news")["rail"], "algorand")
        self.assertEqual(probe._probe_miss_stub(item, "news", "probe_capacity")["rail"], "algorand")

    def test_claim_falls_back_to_the_first_recipient_when_no_accept_is_on_the_observed_rail(self):
        item = {"url": URL, "_rail": "base", "accepts": [BASE_ACCEPT]}
        result = probe.health_from_probe(URL, live_snap(SOLANA_PAYTO, "solana"))
        result = probe.attach_catalog_fields(result, item)
        self.assertEqual(result["claimed"]["payTo"], BASE_PAYTO)
        self.assertNotIn("rail", result["claimed"])  # the public claimed block is unchanged
        self.assertEqual(history._claimed_rail(result["claimed"]), "base")
        self.assertTrue(result["payTo_changed"])
        # The routed path rebuilds `claimed` from stored rows, yet the claim row is still
        # written with the claim's own rail while the probe row carries the observed one.
        routed = probe._finalize_routed_probe(
            probe.health_from_probe(URL, live_snap(SOLANA_PAYTO, "solana", envelope={"x402Version": 2, "accepts": [SOLANA_ACCEPT]})),
            item, "news")
        self.assertNotIn("rail", routed["claimed"])
        history.record_probe(URL, routed)
        conn = self.db()
        self.assertEqual(conn.execute("SELECT rail FROM probes WHERE url = ?", (URL,)).fetchone()[0], "solana")
        rows = {(r[0], r[1]) for r in conn.execute(
            "SELECT source_type, rail FROM observations WHERE url = ? AND field = 'payTo'", (URL,))}
        self.assertEqual(rows, {(history.SOURCE_OBSERVED, "solana"), (history.SOURCE_CLAIMED, "base")})

    def test_history_files_the_row_under_the_observed_rail(self):
        env = {"x402Version": 2, "accepts": [SOLANA_ACCEPT, ALGO_ACCEPT]}
        # The caller passes the listing's rail (the pre-fix routed path); the envelope decides.
        history.record_probe(URL, live_snap(SOLANA_PAYTO, "algorand", envelope=env))
        conn = self.db()
        self.assertEqual(conn.execute("SELECT rail, payTo FROM probes WHERE url = ?", (URL,)).fetchone(),
                         ("solana", SOLANA_PAYTO))
        observed = {r[0] for r in conn.execute(
            "SELECT rail FROM observations WHERE url = ? AND source_type = ?", (URL, history.SOURCE_OBSERVED))}
        self.assertEqual(observed, {"solana"})
        # Without an envelope the caller's rail stands (fixtures, MPP charges).
        history.record_probe(URL + "/mpp", live_snap(BASE_PAYTO, "tempo", amount="1000"))
        self.assertEqual(conn.execute("SELECT rail FROM probes WHERE url = ?", (URL + "/mpp",)).fetchone()[0], "tempo")


class RepairRulesTests(unittest.TestCase):
    def test_repaired_rail_rules(self):
        claims = [{"rail": "base", "payTo": BASE_PAYTO}, {"rail": "algorand", "payTo": ALGO_PAYTO},
                  {"rail": "solana", "payTo": SOLANA_PAYTO}]
        self.assertEqual(history.repaired_rail(URL, SOLANA_PAYTO, "algorand", claims), "solana")
        self.assertEqual(history.repaired_rail(URL, BASE_PAYTO, "solana", claims), "base")
        self.assertEqual(history.repaired_rail(URL, ALGO_PAYTO, "base", claims), "algorand")
        self.assertEqual(history.repaired_rail(URL, SOLANA_PAYTO, "solana", claims), "solana")
        # The same 0x recipient listed on Base and Polygon: a recorded EVM rail is kept; a non-EVM one is not decisive.
        two = [{"rail": "base", "payTo": BASE_PAYTO}, {"rail": "polygon", "payTo": BASE_PAYTO.upper().replace("0X", "0x")}]
        self.assertEqual(history.repaired_rail(URL, BASE_PAYTO, "polygon", two), "polygon")
        self.assertEqual(history.repaired_rail(URL, BASE_PAYTO, "solana", two), "base")
        # A feed-derived catalog rail the address cannot belong to is ignored, so it cannot keep a wrong label.
        mislabelled = [{"rail": "solana", "payTo": BASE_PAYTO}, {"rail": "base", "payTo": BASE_PAYTO}]
        self.assertEqual(history.repaired_rail(URL, BASE_PAYTO, "solana", mislabelled), "base")
        self.assertEqual(history.repaired_rail(URL, SOLANA_PAYTO, "base", [{"rail": "base", "payTo": SOLANA_PAYTO}]), "solana")
        # No catalog: the recipient's shape decides; a 0x recipient keeps an EVM rail, else base.
        self.assertEqual(history.repaired_rail(URL, SOLANA_PAYTO, "algorand", []), "solana")
        self.assertEqual(history.repaired_rail(URL, ALGO_PAYTO, None, []), "algorand")
        self.assertEqual(history.repaired_rail(URL, BASE_PAYTO, "arbitrum", []), "arbitrum")
        self.assertEqual(history.repaired_rail(URL, BASE_PAYTO, "solana", []), "base")
        self.assertEqual(history.repaired_rail(URL, BASE_PAYTO, None, []), "base")
        # No recipient, or one no rail recognizes: keep what was recorded.
        self.assertEqual(history.repaired_rail(URL, None, "algorand", claims), "algorand")
        self.assertEqual(history.repaired_rail(URL, "not-an-address", "algorand", claims), "algorand")
        self.assertIsNone(history.repaired_rail(URL, "not-an-address", None, claims))


class RepairJobTests(TempHistory):
    ROWS = (
        (URL, 1788386471, 1, SOLANA_PAYTO, "5000", "algorand"),        # listed by an Algorand feed, answered on Solana
        (URL + "/evm", 1788386472, 1, BASE_PAYTO, "1000", "solana"),    # 0x recipient filed under Solana
        (URL + "/algo", 1788386473, 1, ALGO_PAYTO, "1000", "base"),
        (URL + "/ok", 1788386474, 1, BASE_PAYTO, "1000", "polygon"),    # already right
        (URL + "/miss", 1788386475, 0, None, None, "algorand"),         # no recipient
    )
    CLAIMS = {URL: [{"rail": "solana", "payTo": SOLANA_PAYTO}, {"rail": "base", "payTo": BASE_PAYTO}]}

    def seed(self):
        history.summary(URL)  # creates the schema
        db = self.db()
        ids = {}
        for url, ts, live, pay_to, amount, rail in self.ROWS:
            cur = db.execute(
                "INSERT INTO probes (url, ts, live, payable, invocable, latency_ms, payTo, amount, miss_reason, rail, "
                "schema_present, settled_route_observation, trust_class, traffic_class) "
                "VALUES (?, ?, ?, ?, 0, 10, ?, ?, NULL, ?, 0, 1, 'ROUTE_SETTLED', 'organic')",
                (url, ts, live, live, pay_to, amount, rail))
            ids[url] = cur.lastrowid
            for source_type, status, value in ((history.SOURCE_OBSERVED, "observed", pay_to or "0"),
                                               (history.SOURCE_CLAIMED, "claimed", BASE_PAYTO)):
                db.execute(
                    "INSERT INTO observations (probe_id, batch_id, source_type, source, rail, url, field, value, status, ts, trust_class) "
                    "VALUES (?, 'b', ?, 'discovery', ?, ?, 'payTo', ?, ?, ?, 'ROUTE_SETTLED')",
                    (cur.lastrowid, source_type, rail, url, value, status, ts))
        db.commit()
        db.close()
        return ids

    def rails(self):
        db = self.db()
        try:
            return {url: rail for url, rail in db.execute("SELECT url, rail FROM probes")}
        finally:
            db.close()

    def test_repair_relabels_stored_rows_in_chunks_then_stops(self):
        self.seed()
        with patch("live402.shadow.accept_claims", side_effect=lambda u: self.CLAIMS.get(u, [])):
            first = history.repair_probe_rails(limit=2)
            self.assertEqual((first["scanned"], first["changed"], first["done"]), (2, 2, False))
            second = history.repair_probe_rails(limit=2)
            self.assertEqual((second["scanned"], second["changed"], second["done"]), (2, 1, False))
            third = history.repair_probe_rails(limit=2)
            self.assertEqual((third["scanned"], third["changed"], third["done"]), (0, 0, True))
            again = history.repair_probe_rails(limit=2)
            self.assertEqual((again["scanned"], again["changed"], again["done"]), (0, 0, True))
        self.assertEqual(self.rails(), {
            URL: "solana", URL + "/evm": "base", URL + "/algo": "algorand", URL + "/ok": "polygon", URL + "/miss": "algorand",
        })
        db = self.db()
        observed = dict(db.execute("SELECT url, rail FROM observations WHERE source_type = ?", (history.SOURCE_OBSERVED,)))
        self.assertEqual(observed[URL], "solana")
        self.assertEqual(observed[URL + "/evm"], "base")
        self.assertEqual(observed[URL + "/miss"], "algorand")
        # Claim rows keep their own label; the repair only touches what was observed.
        claimed = dict(db.execute("SELECT url, rail FROM observations WHERE source_type = ?", (history.SOURCE_CLAIMED,)))
        self.assertEqual(claimed[URL], "algorand")
        db.close()

    def test_repair_ships_the_corrected_rows_to_the_replica_outbox(self):
        self.seed()
        with patch.dict(os.environ, {"LIVE402_HISTORY_BACKEND": "dual"}), \
                patch("live402.shadow.accept_claims", side_effect=lambda u: self.CLAIMS.get(u, [])):
            step = history.repair_probe_rails(limit=100)
        self.assertEqual((step["changed"], step["done"]), (3, True))
        db = self.db()
        payloads = [json.loads(p) for (p,) in db.execute("SELECT payload FROM replica_outbox ORDER BY id")]
        db.close()
        self.assertEqual(len(payloads), 1)
        shipped = {row["url"]: row["rail"] for row in payloads[0]["probes"]}
        self.assertEqual(shipped, {URL: "solana", URL + "/evm": "base", URL + "/algo": "algorand"})
        shipped_obs = {(row["url"], row["source_type"]): row["rail"] for row in payloads[0]["observations"]}
        self.assertEqual(shipped_obs[(URL, history.SOURCE_OBSERVED)], "solana")
        self.assertEqual(shipped_obs[(URL, history.SOURCE_CLAIMED)], "algorand")

    def test_writer_job_is_registered(self):
        self.assertIn(("history_rail_repair", 30.0), maintenance.JOBS)
        with patch("live402.history.repair_probe_rails",
                   return_value={"cursor": 5, "max_id": 5, "scanned": 5, "changed": 2, "done": True}) as fn:
            maintenance._history_rail_repair()
        fn.assert_called_once()


if __name__ == "__main__":
    unittest.main()
