"""Membership shares must not silently become unique-resource reach."""
import sqlite3
import unittest

from scripts.endpoint_report import catalog_section


class EndpointReportMembershipTests(unittest.TestCase):
    def test_duplicate_offers_do_not_duplicate_memberships_but_networks_do(self):
        with sqlite3.connect(":memory:") as conn:
            conn.executescript("""
                CREATE TABLE resources (id INTEGER, canonical_url TEXT, first_seen INTEGER,
                    input_schema_present INTEGER, capability TEXT);
                CREATE TABLE resource_sources (resource_id INTEGER, source TEXT);
                CREATE TABLE accept_claims (resource_id INTEGER, network TEXT, facilitator TEXT);
                CREATE TABLE claim_events (ts INTEGER, canonical_url TEXT, event TEXT, source TEXT, detail TEXT);
                INSERT INTO resources VALUES
                    (1, 'https://one.example/a', 1, 1, 'search.web'),
                    (2, 'https://two.example/a', 1, 0, NULL),
                    (3, 'https://three.example/a', 1, 1, 'search.web');
                INSERT INTO accept_claims VALUES
                    (1, 'eip155:8453', NULL), (1, 'eip155:8453', NULL),
                    (1, 'solana:example', NULL), (2, 'eip155:8453', NULL),
                    (3, 'algorand:long', NULL), (3, 'algorand:short', NULL);
            """)
            report = catalog_section(conn, 0)
        self.assertEqual(report["resources_total"], 3)
        self.assertEqual(report["network_memberships_total"], 5)
        self.assertEqual(report["network_share_basis"], "distinct_resource_network_memberships")
        base = next(row for row in report["networks"] if row["network"] == "eip155:8453")
        self.assertEqual(base["listings"], 2)
        self.assertEqual(base["share"], 40.0)
        self.assertNotEqual(base["share"], round(100 * 2 / 3, 1))
        self.assertEqual(report["network_count"], 4)
