"""Customer-site contracts, including unchanged payment and privacy boundaries.

Browser tests exercise rendering and events. These tests check server behavior,
claims, navigation, metadata and the existing machine contracts without freezing
superseded marketing prose. Payment/SSRF/XSS/receipt suites stay separate.
"""
import json
import os
import re
import tempfile
import threading
import unittest
from html.parser import HTMLParser
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

os.environ.setdefault("LIVE402_FIXTURE", "1")
os.environ.pop("LOCAL_FREE", None)
from live402.server import Handler, CSP
from live402 import site_chrome

STATIC = Path(__file__).resolve().parent.parent / "live402" / "static"
ROOT = STATIC.parent.parent
NAV_LABELS = ("Product", "Developers", "Explore", "Pricing", "Trust")
NAV_HREFS = ("/#product", "/developers", "/catalog", "/#pricing", "/how#trust")
BANNED = ("Seamless", "Revolutionary", "Game-changing", "Built to empower", "Bridge the gap", "UNKNOWN is better than a guess", "Integrate in two minutes.", "quantum-proof", "fully quantum-safe", "PQ-safe")


def _get_full(port, path, extra_headers=None):
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path, headers=dict(extra_headers or {}))
    res = conn.getresponse()
    raw, headers, status = res.read(), {k.lower(): v for k, v in res.getheaders()}, res.status
    conn.close()
    return status, raw.decode("utf-8"), headers


class _DocParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.nav_links, self.h1, self.title, self.ids, self.nodes, self.text = [], [], [], [], [], [], []
        self._primary, self._anchor, self._heading, self._title = False, None, None, None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.nodes.append((tag, attrs))
        if attrs.get("id"):
            self.ids.append(attrs["id"])
        if tag == "nav" and attrs.get("aria-label") == "Primary":
            self._primary = True
        if tag == "a":
            self._anchor = [attrs.get("href", ""), []]
        if tag == "h1":
            self._heading = []
        if tag == "title":
            self._title = []

    def handle_data(self, data):
        self.text.append(data)
        for target in (self._heading, self._title):
            if target is not None:
                target.append(data)
        if self._anchor is not None:
            self._anchor[1].append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._anchor is not None:
            item = ("".join(self._anchor[1]).strip(), self._anchor[0])
            self.links.append(item)
            if self._primary:
                self.nav_links.append(item)
            self._anchor = None
        if tag == "nav":
            self._primary = False
        if tag == "h1" and self._heading is not None:
            self.h1.append("".join(self._heading).strip())
            self._heading = None
        if tag == "title" and self._title is not None:
            self.title.append("".join(self._title).strip())
            self._title = None


def _parse(html):
    result = _DocParser()
    result.feed(html)
    return result


def _read(name):
    return (STATIC / name).read_text(encoding="utf-8")


def _text(html):
    return " ".join(" ".join(_parse(html).text).split())


class HomepageProductTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.pop("LOCAL_FREE", None)
        os.environ["LIVE402_FIXTURE"] = "1"
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["LIVE402_PQ_LOG_DB"] = os.path.join(cls.tmp.name, "pq-log.sqlite")
        from live402.pq import store
        store.reset()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.host, cls.port = cls.httpd.server_address
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.pages = {}
        for path in ("/", "/catalog", "/how", "/developers", "/contact", "/insights/pre-spend-routing", "/transparency", "/dashboard", "/route"):
            status, html, _ = _get_full(cls.port, path, {"Accept": "text/html"})
            if status != 200:
                raise AssertionError((path, status))
            cls.pages[path] = html
        cls.home, cls.catalog, cls.how, cls.devs, cls.transparency = (cls.pages[p] for p in ("/", "/catalog", "/how", "/developers", "/transparency"))
        cls.js, cls.css = _read("app.js"), _read("styles.css")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        from live402.pq import store
        store.reset()
        os.environ.pop("LIVE402_PQ_LOG_DB", None)
        cls.tmp.cleanup()

    def assertWords(self, html, phrases):
        text = _text(html)
        for phrase in phrases:
            self.assertIn(phrase, text)

    def test_problem_first_product_and_visible_primer(self):
        self.assertWords(self.home, ("Check the deal before your agent pays.", "New to agent payments?", "An API is a service", "x402 and MPP", "hosted API", "local guard", "signed binding", "Your buyer still validates"))
        self.assertNotIn('id="integration-example"', self.home)
        self.assertNotIn("AgentsTools", self.home)

    def test_scenarios_are_not_invented_customer_incidents(self):
        self.assertWords(self.home, ("They are not customer incidents", "100,000", "$2,000", "$20,000", "rules actually submitted", "not a recording of every agent action"))
        self.assertWords(self.how, ("Neither study used 402Signal", "controlled simulations", "not reported customer incidents"))
        for href in ("https://www.anthropic.com/research/project-vend-1", "https://www.anthropic.com/research/agentic-misalignment"):
            self.assertIn(href, [url for _, url in _parse(self.how).links])

    def test_try_action_and_offline_test_are_distinct(self):
        self.assertIn(("Try a sample check", "/how#playground"), _parse(self.home).links)
        self.assertWords(self.how, ("Simulated example", "No wallet", "No payment in this demonstration", "actual verifier"))
        self.assertIn('<noscript>', self.how)
        self.assertWords(self.devs, ("seven passing cases", "fake callback", "not a sandbox", "security audit"))
        self.assertTrue((ROOT / "integration/buyer-checks/run.mjs").is_file())

    def test_demo_has_acceptance_refusal_and_free_miss(self):
        for value in ("same", "price", "recipient", "expired", "miss"):
            self.assertIn('value="%s"' % value, self.how)
        for phrase in ("Stop: price changed", "Stop: recipient changed", "Stop: evidence expired", "No qualifying offer", "Signing callback not called"):
            self.assertIn(phrase, self.js)
        self.assertIn("does not promise useful output", self.how)

    def test_flow_preserves_word_boundaries(self):
        labels = re.findall(r'<div class="map-node[^\"]*">.*?<strong>(.*?)</strong>', self.how, re.S)
        self.assertEqual(labels, ["Set the request and spending rules", "Observe the API and check its terms", "Verify the evidence. Proceed or stop."])
        self.assertNotIn("<br", "".join(labels))
        self.assertWords(self.how, ("Direct payment", "checking fee is a separate payment", "buyer validates transaction effects"))

    def test_pricing_not_fulfillment_or_every_session_call(self):
        self.assertWords(self.home, ("$0.003", "Completed no-match checks are free", "No subscription", "Seller charges", "later buyer refusal", "does not buy another observation for every call"))
        self.assertIn("not a guarantee of delivery or output quality", self.home)
        self.assertWords(self.devs, ("billing.settlement_state=not_attempted", "HTTP 503", "already-settled checking fee"))

    def test_scope_is_in_guide_not_release_history_on_home(self):
        self.assertNotIn("Controlled MainNet tests are complete", self.home)
        self.assertWords(self.devs, ("native MPP", "1 to 64", "24 hours", "2 to 15", "2 to 64", "receiver/token", "not a per-call price", "per_call_amount_atomic", "null", "hosted enablement"))
        self.assertIn("Do not replace a recipient pin", self.devs)

    def test_navigation_and_legacy_sections(self):
        self.assertEqual(site_chrome.NAV, tuple(zip(NAV_HREFS, NAV_LABELS)))
        for path, html in self.pages.items():
            with self.subTest(path=path):
                self.assertEqual(_parse(html).nav_links, list(zip(NAV_LABELS, NAV_HREFS)))
                self.assertIn('class="mark"', html)
                self.assertIn('class="brand-name"', html)
        for anchor in ("quickstart", "request", "route-binding", "batch-support", "recovery", "interfaces", "policy-guide", "pq-trust"):
            self.assertIn(anchor, _parse(self.devs).ids)

    def test_task_panels_and_copied_briefs_have_real_targets(self):
        doc = _parse(self.devs)
        panels = [attrs for tag, attrs in doc.nodes if "data-guide" in attrs]
        self.assertGreaterEqual(len(panels), 9)
        for attrs in panels:
            self.assertNotIn("hidden", attrs)  # Readable without JavaScript.
        buttons = [attrs for tag, attrs in doc.nodes if tag == "button" and "data-copy-target" in attrs]
        self.assertGreaterEqual(len(buttons), 5)
        for attrs in buttons:
            self.assertIn(attrs["data-copy-target"], doc.ids)
        self.assertIn("CSS.escape", self.js)
        self.assertTrue((ROOT / "skills/402signal-buyer-checks/SKILL.md").is_file())

    def test_catalog_claims_time_and_unknown_scope(self):
        self.assertIn("This free search does not check endpoints again.", self.catalog)
        for phrase in ("Seller says", "Previously observed", "No prior 402Signal observation", 'obs.status === "observed"', "Observation timestamp: ", "stamp.dateTime", "Date.now() + 60000", "Observation time unavailable", "Not supplied; do not assume free", "not settlement time"):
            self.assertIn(phrase, self.js)
        for phrase in ("Recently checked", "Payable now", "quality verified", "trusted merchant"):
            self.assertNotIn(phrase, self.js)
        self.assertIn('hit.scheme !== "exact"', self.js)
        self.assertIn("variable prices are not compared", self.catalog)
        self.assertIn("chain-account readiness", self.js)

    def test_catalog_refinement_and_exact_selection(self):
        for field in ("display-filter", "display-sort", "catalog-summary", "result-controls"):
            self.assertIn('id="%s"' % field, self.catalog)
        self.assertIn("only the listings in this response", self.catalog)
        self.assertIn("your spending rules have not changed", self.js)
        self.assertIn("coverage is not exhaustive", self.js)
        for phrase in ("Build check request", "Copy endpoint", "body.url = url", '$("endpoint-url").value = hit.url'):
            self.assertIn(phrase, self.js)
        self.assertWords(self.catalog, ("original URL and query encoding are preserved", "does not change your required network"))

    def test_builder_binding_and_numeric_fields(self):
        inputs = {attrs.get("id"): attrs for tag, attrs in _parse(self.catalog).nodes if tag == "input"}
        self.assertIn("checked", inputs["require-binding"])
        for id_ in ("max-price", "max-total-cost", "max-latency", "min-observations"):
            self.assertEqual(inputs[id_]["type"], "text")
            self.assertIn(inputs[id_]["inputmode"], ("decimal", "numeric"))
            self.assertIn(id_ + "-error", inputs[id_]["aria-describedby"])
        for phrase in ("body.require_route_binding = true", "parsed.error", "valid = false", '$("copy-route-json").disabled = !valid', '$("copy-route-curl").disabled = !valid', "Number.isSafeInteger", "up to 6 decimals", "return { absent: true }", "will reject an unbound response"):
            self.assertIn(phrase, self.js)
        self.assertNotIn("Math.floor(n)", self.js)
        self.assertIn("flag alone does not enforce wallet policy", self.catalog)

    def test_schema_field_mapping_and_cost_units(self):
        from live402 import schema_fields
        props = schema_fields.route_body_schema()["properties"]
        for key in ("url", "need", "networks", "max_price_usd", "require_invocable", "min_observations", "objective", "prefer_network", "max_total_cost_usd", "max_latency_ms", "search_depth", "require_route_binding"):
            self.assertIn(key, props)
            self.assertIn(key, self.js)
        self.assertNotIn("body.network =", self.js)
        self.assertIn("&networks=", self.js)
        self.assertIn("&prefer_network=", self.js)
        self.assertWords(self.catalog, ("Maximum seller price (USD)", "excludes the separate $0.003 routing fee", "not a whole-wallet budget", "This is not settlement latency", "Unknown required cost components fail closed"))
        self.assertIn("not an additional enforced wallet limit", self.js)

    def test_catalog_cannot_pay_or_import_policy(self):
        self.assertIn("This page builds the request but does not submit or charge it.", self.catalog)
        for phrase in ("window.ethereum", "WalletConnect", 'fetch("/route"', "fetch('/route", "localStorage", "sessionStorage", "innerHTML"):
            self.assertNotIn(phrase, self.js)
        self.assertIn('credentials: "omit"', self.js)
        self.assertIn('redirect: "error"', self.js)
        self.assertIn("A share link may prefill a capability, never policies or credentials", self.js)
        self.assertIn("shellSingleQuote(compact)", self.js)

    def test_seller_interface_is_explicit_unpaid_and_bounded(self):
        for id_ in ("seller-form", "seller-url", "seller-check", "seller-status", "seller-result", "seller-json"):
            self.assertIn(id_, _parse(self.devs).ids)
        self.assertWords(self.devs, ("no_candidates", "without a seller probe", "not a full payment test", "receiving token account", "not continuous monitoring"))
        for phrase in ("/validate?url=", "result.url !== exact", "length > 262144", "ticket !== generation", "controller.abort()", "No seller probe was made", "never submits the check"):
            self.assertIn(phrase, self.js + self.devs)
        self.assertIn("seller-form", self.js)
        self.assertNotIn('id="seller-form"', self.catalog)

    def test_search_resource_and_concurrency_bounds(self):
        for phrase in ("AbortController", "controller.abort()", "sequence !== state.sequence", "MAX_RESPONSE", "reader.cancel()", "query.length > 300", "parsed.hits.length > 200", 'setAttribute("aria-busy", "false")', "invalidateSearch", "Too many searches", "Search timed out", "No catalog matches found"):
            self.assertIn(phrase, self.js)

    def test_keyboard_and_css_not_overflow_masking(self):
        self.assertNotIn('role="radiogroup"', self.catalog)
        for group in ("network-chips", "prefer-chips", "objective-chips", "depth-chips"):
            match = re.search(r'id="%s"[^>]*>(.*?)</div>' % group, self.catalog, re.S)
            self.assertIsNotNone(match)
            self.assertEqual(match.group(1).count('aria-pressed="true"'), 1)
        for phrase in ("button:focus-visible", '.chip[aria-pressed="true"]', "prefers-reduced-motion", "min-width: 0", "font-size: 16px", ".lookup-row", ".lookups"):
            self.assertIn(phrase, self.css)
        self.assertNotIn("overflow-x: hidden", self.css)
        self.assertNotIn(".blur()", self.js)

    def test_runtime_installation_and_guard_responsibilities(self):
        self.assertWords(self.devs, ("Node.js 22 or newer", "Node 24", "POSIX", "not an npm registry release", "sha256sum --check SHA256SUMS", "PUBLIC TEST KEY", "independent trusted configuration", "default observation window is 60 seconds", "transaction effects", "prevent", "scaffolding, not complete wallet code"))
        self.assertIn("withVerifiedRoute", self.devs)
        self.assertIn("verifyReceipt", self.devs)

    def test_billing_recovery_and_mcp_scope(self):
        self.assertWords(self.devs, ("HTTP 402", "HTTP 200", "HTTP 503", "billing.settlement_state=not_attempted", "client.recover(attemptId)", "Do not reuse an unknown authorization", "Do not generate another payment", "not MCP", "they are not customer wallet keys", "cannot sign, forward payment headers or complete a paid route"))
        for href in ("/openapi.json", "/mcp.json", "/llms.txt"):
            self.assertIn(href, [url for _, url in _parse(self.devs).links])
        self.assertIn("HTTP-only", self.devs)

    def test_policy_and_evidence_boundaries(self):
        self.assertWords(self.devs, ("Keep enforceable policy outside the model", "Trusted application code", "not a permanent organization-wide recipient allowlist", "no hosted approval queue", "not a throughput certification", "do not put it in public logs", "not a long-term evidence backup", "Falcon-1024", "Ed25519"))
        self.assertWords(self.how, ("cannot recover a deleted private record", "purchases that bypassed 402Signal", "not an automatic agent-monitoring dashboard", "does not itself verify the later Falcon anchor", "Pending is not confirmed", "not a backup service"))
        for phrase in ("Keep your verification record", "not long-term evidence storage", "changed evidence will fail verification"):
            self.assertIn(phrase, self.transparency)
        readme = ROOT.joinpath("README.md").read_text()
        self.assertIn("must securely retain the complete paid `/route` response", readme)
        self.assertIn("not long-term evidence storage", readme)

    def test_evidence_disclosure_matches_machine_contracts(self):
        from live402 import discover, mcp, payment, schema_fields
        spec = discover.openapi_spec()
        request = spec["paths"]["/route"]["post"]["requestBody"]["content"]["application/json"]["schema"]
        desc = request["properties"]["require_transparency"]["description"]
        self.assertIn("not server-side recovery", desc)
        self.assertIn("Private replay outcomes support bounded recovery", desc)
        response = spec["paths"]["/route"]["post"]["responses"]["200"]["content"]["application/json"]["schema"]["properties"]
        transparency = response["pq_trust"]["properties"]["transparency"]
        self.assertIn("reveal", transparency["properties"])
        self.assertIn("Not published in the public log", transparency["properties"]["reveal"]["description"])
        tool = next(t for t in mcp.manifest()["tools"] if t["name"] == "route")
        self.assertEqual(tool["inputSchema"]["properties"]["require_transparency"]["description"], schema_fields.REQUIRE_TRANSPARENCY_DESC)
        self.assertIn("reveal", tool["outputSchema"]["properties"]["pq_trust"]["properties"]["transparency"]["properties"])
        self.assertIn("Private replay outcomes support bounded recovery", discover.GUIDANCE)
        self.assertIn("do not put it in public logs", discover.LLMS_TXT)
        self.assertIn("Private replay outcomes support bounded recovery", payment.BAZAAR_MCP["info"]["input"]["inputSchema"]["properties"]["require_transparency"]["description"])

    def test_transparency_does_not_collect_or_overclaim(self):
        self.assertNotIn("<form", self.transparency)
        self.assertNotIn("customer-search", self.transparency)
        for phrase in ("Public transparency commitments do not expose raw needs, wallets, payment signatures, or seller response bodies.", "What is published?", "What the checkpoint proves", "Later changes to that earlier history become detectable.", "e6b81414", "Historical TestNet archive", "It does not make seller payments on Base, Solana, or Algorand post-quantum secure"):
            self.assertIn(phrase, self.transparency)
        self.assertNotIn("Currently Algorand TestNet", self.home + self.devs + self.transparency)

    def test_generated_presentation_is_idempotent_and_scoped(self):
        for path in ("/dashboard", "/route", "/transparency"):
            html = self.pages[path]
            self.assertEqual(site_chrome.prepare_generated_html(html), html)
            self.assertEqual(html.count('id="customer-page-context"'), 1)
        self.assertEqual(site_chrome.prepare_generated_html(_read("index.html")), _read("index.html"))
        raw = '{"note":"not a human page"}'
        self.assertEqual(site_chrome.prepare_generated_html(raw), raw)

    def test_page_structure_contacts_and_anchors(self):
        for path, html in self.pages.items():
            with self.subTest(path=path):
                doc = _parse(html)
                self.assertEqual(len(doc.h1), 1)
                self.assertEqual(len(doc.title), 1)
                self.assertEqual(len(doc.ids), len(set(doc.ids)))
                self.assertIn('name="viewport"', html)
                self.assertIn("width=device-width", html)
                for href, _, _ in site_chrome.FOOTER:
                    self.assertIn(href, [url for _, url in doc.links])
                self.assertIn("ross@402signal.com", html)
                self.assertNotIn("402signal@gmail.com", html)
                for _, href in doc.links:
                    parts = urlsplit(href)
                    if not parts.scheme and parts.fragment and (parts.path or path) in self.pages:
                        self.assertIn(parts.fragment, _parse(self.pages[parts.path or path]).ids, (path, href))
        self.assertWords(self.pages["/contact"], ("Please keep sensitive details out of public issues.", "Do not send private keys"))
        self.assertIn("/.well-known/security.txt", self.pages["/contact"])
        self.assertEqual(_parse(self.catalog).title, ["Explore paid APIs · 402Signal"])

    def test_no_inline_code_em_dash_or_overclaims(self):
        for path, html in self.pages.items():
            self.assertNotIn("\N{EM DASH}", html, path)
            for phrase in BANNED:
                self.assertNotIn(phrase, html, (path, phrase))
            for tag, attrs in _parse(html).nodes:
                self.assertFalse(any(k.lower().startswith("on") for k in attrs))
                if tag == "script":
                    self.assertTrue(attrs.get("src", "").startswith("/"))
                if tag == "a":
                    self.assertFalse(attrs.get("href", "").lower().startswith("javascript:"))
            if path not in ("/dashboard", "/transparency"):
                self.assertIn("Skip to content", html)
        for name in ("index.html", "catalog.html", "how.html", "developers.html", "contact.html", "route.html", "pre-spend-routing.html", "app.js", "dashboard.js", "transparency.js"):
            self.assertNotIn("\N{EM DASH}", _read(name), name)
        labels = {attrs["for"] for tag, attrs in _parse(self.catalog).nodes if tag == "label" and "for" in attrs}
        for name in ("need", "endpoint-url", "max-price", "min-observations", "max-total-cost", "max-latency", "display-filter", "display-sort"):
            self.assertIn(name, labels)

    def test_metadata_assets_and_original_csp(self):
        from live402 import asset_version
        version = asset_version.asset_version()
        expected = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"
        self.assertEqual(CSP, expected)
        for path, html in self.pages.items():
            self.assertIn("/styles.css?v=" + version, html)
            self.assertNotIn('href="/styles.css"', html)
            self.assertNotIn("FLY_IMAGE_REF", html)
            status, _, headers = _get_full(self.port, path, {"Accept": "text/html"})
            self.assertEqual(status, 200)
            self.assertIn("text/html", headers["content-type"])
            self.assertEqual(headers.get("content-security-policy"), expected)
        for path in ("/catalog", "/how", "/developers"):
            self.assertIn("/app.js?v=" + version, self.pages[path])
        self.assertIn("/transparency.js?v=" + version, self.transparency)
        self.assertIn("/dashboard.js?v=" + version, self.pages["/dashboard"])
        for name in ("index.html", "catalog.html", "how.html", "developers.html", "contact.html"):
            self.assertIn('href="/styles.css"', _read(name))
            self.assertNotIn("?v=", _read(name))
        self.assertIn('rel="canonical" href="https://402signal.com/"', self.home)
        self.assertIn('property="og:image" content="https://402signal.com/og.png"', self.home)

    def test_machine_interfaces_and_unpaid_route_preserved(self):
        for path in ("/preview?need=weather", "/openapi.json", "/mcp.json", "/.well-known/x402.json", "/rails", "/pulse", "/llms.txt"):
            status, raw, _ = _get_full(self.port, path)
            self.assertEqual(status, 200, path)
            self.assertTrue(raw.strip())
        preview = json.loads(_get_full(self.port, "/preview?need=weather")[1])
        self.assertTrue(preview["not_probed"])
        self.assertIn("hits", preview)
        manifest = json.loads(_get_full(self.port, "/mcp.json")[1])
        self.assertTrue({"route", "preview", "validate"}.issubset({t["name"] for t in manifest["tools"]}))
        self.assertEqual(_get_full(self.port, "/mcp/v0.3.1")[0], 405)
        conn = HTTPConnection(self.host, self.port, timeout=5)
        conn.request("POST", "/route", json.dumps({"need": "weather"}), {"Content-Type": "application/json"})
        res = conn.getresponse()
        data = json.loads(res.read())
        self.assertEqual(res.status, 402)
        self.assertIn("accepts", data)
        conn.close()

    def test_cache_paths_and_private_files_preserved(self):
        from live402 import asset_version
        version = asset_version.asset_version()
        for path in ("/", "/catalog", "/how"):
            self.assertEqual(_get_full(self.port, path)[2].get("cache-control"), asset_version.HTML_REVALIDATE)
        self.assertEqual(_get_full(self.port, "/transparency")[2].get("cache-control"), "no-store")
        for path in ("/styles.css", "/app.js"):
            status, _, headers = _get_full(self.port, path + "?v=" + version)
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("cache-control"), asset_version.ASSET_LONG_CACHE)
        self.assertEqual(_get_full(self.port, "/styles.css")[2].get("cache-control"), asset_version.HTML_REVALIDATE)
        self.assertEqual(json.loads(_get_full(self.port, "/health")[1]), {"ok": True})
        for path in ("/styles.css/../server.py", "/app.js/../../README.md", "/dashboard.js/%2e%2e/asset_version.py"):
            status, raw, headers = _get_full(self.port, path)
            self.assertEqual(status, 404)
            self.assertIn("json", headers.get("content-type", ""))
            self.assertNotIn("def ", raw)

    def test_sitemap_security_contact_and_404(self):
        for path in ("/favicon.svg", "/sitemap.xml", "/.well-known/security.txt", "/.well-known/x402list.txt"):
            status, raw, _ = _get_full(self.port, path)
            self.assertEqual(status, 200)
            self.assertTrue(raw)
        self.assertEqual(_get_full(self.port, "/.well-known/x402list.txt")[1], "x402list-verify-52dmS9yTO-vP6AMJh6H8mZZBInntQZP7zSLPF806CnQ\n")
        for name in ("og.png", "hero-routing.png"):
            self.assertGreater((STATIC / name).stat().st_size, 10000)
        sitemap = _get_full(self.port, "/sitemap.xml")[1]
        for path in ("catalog", "insights/pre-spend-routing"):
            self.assertIn("https://402signal.com/" + path, sitemap)
        self.assertIn("Sitemap: https://402signal.com/sitemap.xml", _get_full(self.port, "/robots.txt")[1])
        self.assertIn('name="robots" content="noindex, nofollow"', self.pages["/dashboard"])
        status, html, headers = _get_full(self.port, "/not-a-real-page", {"Accept": "text/html"})
        self.assertEqual(status, 404)
        self.assertIn("text/html", headers.get("content-type", ""))
        self.assertIn("That page is not here.", html)
        status, raw, headers = _get_full(self.port, "/not-a-real-page")
        self.assertEqual(status, 404)
        self.assertIn("json", headers.get("content-type", ""))
        self.assertIn("not found", raw)


if __name__ == "__main__":
    unittest.main()
