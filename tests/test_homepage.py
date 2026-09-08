"""Human-site contracts; actual layout and interactions run in browser.mjs.

Presentation assertions describe customer-visible boundaries rather than locking
old prose, variable names, hidden line breaks or overflow-masking CSS in place.
Payment/SSRF/XSS/receipt suites remain separate and unchanged.
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
NAV_LABELS = ("Explore", "Developers", "Transparency", "GitHub")
NAV_HREFS = ("/catalog", "/developers", "/transparency", "https://github.com/402signalhq/402signal")
BANNED = ("Seamless", "Revolutionary", "Game-changing", "Built to empower", "Bridge the gap", "UNKNOWN is better than a guess", "Integrate in two minutes.", "quantum-proof", "fully quantum-safe", "PQ-safe")


def _serve():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, *httpd.server_address


def _get_full(port, path, extra_headers=None):
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path, headers=dict(extra_headers or {}))
    res = conn.getresponse()
    raw = res.read()
    headers = {k.lower(): v for k, v in res.getheaders()}
    conn.close()
    return res.status, raw.decode("utf-8"), headers


class _DocParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.nav_links = []
        self.h1 = []
        self.title = []
        self.ids = []
        self.nodes = []
        self.text = []
        self._primary = False
        self._anchor = None
        self._heading = None
        self._title = None

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
        if self._anchor is not None:
            self._anchor[1].append(data)
        if self._heading is not None:
            self._heading.append(data)
        if self._title is not None:
            self._title.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._anchor is not None:
            href, parts = self._anchor
            item = ("".join(parts).strip(), href)
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
    doc = _DocParser()
    doc.feed(html)
    return doc


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
        cls.httpd, cls.host, cls.port = _serve()
        cls.pages = {}
        for path in ("/", "/catalog", "/how", "/developers", "/contact", "/insights/pre-spend-routing", "/transparency", "/dashboard", "/route"):
            status, html, _ = _get_full(cls.port, path, {"Accept": "text/html"})
            if status != 200:
                raise AssertionError((path, status))
            cls.pages[path] = html
        cls.home = cls.pages["/"]
        cls.catalog = cls.pages["/catalog"]
        cls.how = cls.pages["/how"]
        cls.devs = cls.pages["/developers"]
        cls.transparency = cls.pages["/transparency"]
        cls.js, cls.css = _read("app.js"), _read("styles.css")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        from live402.pq import store
        store.reset()
        os.environ.pop("LIVE402_PQ_LOG_DB", None)
        cls.tmp.cleanup()

    def test_product_names_the_hosted_and_local_parts(self):
        text = _text(self.home)
        for phrase in ("hosted API", "local guard", "existing wallet", "signed binding", "Keep the record"):
            self.assertIn(phrase, text)
        self.assertIn("Check the offer before your agent pays.", text)

    def test_try_action_is_a_no_payment_demonstration(self):
        self.assertIn(("Try a sample check", "/how#playground"), _parse(self.home).links)
        for phrase in ("Simulated example", "No wallet", "do not run the cryptographic guard", "No payment in this demonstration"):
            self.assertIn(phrase, _text(self.how))
        self.assertIn('id="demo-scenario"', self.how)
        self.assertIn('<noscript>', self.how)

    def test_demo_covers_stopping_and_free_initial_misses(self):
        for value in ("same", "price", "recipient", "expired", "miss"):
            self.assertIn('value="%s"' % value, self.how)
        for phrase in ("Stop: price changed", "Stop: recipient changed", "Stop: evidence expired", "No qualifying offer", "Signing callback not called"):
            self.assertIn(phrase, self.js)
        self.assertIn("does not guarantee", self.how)

    def test_flow_preserves_word_boundaries(self):
        labels = re.findall(r'<div class="map-node[^\"]*">.*?<strong>(.*?)</strong>', self.how, re.S)
        self.assertEqual(labels, ["Set the request and spending rules", "Observe the API and check its terms", "Verify the evidence. Proceed or stop."])
        self.assertNotIn("<br", "".join(labels))
        self.assertIn("Direct payment", self.how)
        self.assertIn("402Signal does not hold the seller payment", self.how)

    def test_pricing_is_for_observation_not_fulfillment(self):
        for phrase in ("$0.003", "Completed checks with no match are free", "Seller payment is separate", "$0.023 combined, before any network fees", "check remains paid", "No subscription"):
            self.assertIn(phrase, _text(self.home))
        self.assertIn("not a completed seller purchase", _text(self.home))
        self.assertIn("does not guarantee the paid output", self.home)

    def test_qualification_status_is_dated_and_bounded(self):
        self.assertIn("September 8, 2026", self.home)
        self.assertIn("Controlled MainNet tests are complete", self.home)
        self.assertIn("owner-operated lab endpoints", self.home)
        for phrase in ("hosted enablement", "An ordinary exact-payment receipt does not authorize a batch or session", "not a per-call price", "per_call_amount_atomic", "null", "not native MPP settlement support", "two USDC payments to the same recipient"):
            self.assertIn(phrase, _text(self.devs))

    def test_recorded_external_example_has_no_quality_guarantee(self):
        text = _text(self.home)
        for phrase in ("September 7, 2026", "AgentsTools", "Parallel", "refused seller signing", "not endorsements", "present availability"):
            self.assertIn(phrase, text)
        self.assertIn("not a qualified live purchase path for rotating recipients", _text(self.devs))
        self.assertIn("Do not replace a recipient pin", _text(self.devs))

    def test_catalog_claims_and_observations_are_separate(self):
        self.assertIn("This free search does not check endpoints again.", self.catalog)
        for phrase in ("Seller says", "Previously observed", "No prior 402Signal observation", "Historical evidence, not current availability or output quality", 'obs.status === "observed"'):
            self.assertIn(phrase, self.js)
        for phrase in ("Recently checked", "Payable now", "7d reliability", "quality verified", "trusted merchant"):
            self.assertNotIn(phrase, self.js)

    def test_catalog_time_has_relative_and_exact_forms(self):
        self.assertIn("Last observed ", self.js)
        self.assertIn("Observation time unavailable", self.js)
        self.assertIn("Observation timestamp: ", self.js)
        self.assertIn("stamp.dateTime", self.js)
        self.assertIn("Date.now() + 60000", self.js)

    def test_catalog_unknown_is_not_zero_or_free(self):
        for phrase in ("Not supplied; do not assume free", "Unknown", "not settlement time", "Observations in the last 7 days"):
            self.assertIn(phrase, self.js)
        self.assertIn('hit.scheme !== "exact"', self.js)
        self.assertIn("listedFixedPrice", self.js)
        self.assertIn("variable prices are not compared", self.catalog)

    def test_catalog_refinement_is_not_a_spending_rule(self):
        for field in ("display-filter", "display-sort", "catalog-summary", "result-controls"):
            self.assertIn('id="%s"' % field, self.catalog)
        self.assertIn("only the listings in this response", self.catalog)
        self.assertIn("your spending rules have not changed", self.js)
        self.assertIn("coverage is not exhaustive", self.js)

    def test_catalog_selection_preserves_exact_endpoint(self):
        self.assertIn("Check this endpoint", self.js)
        self.assertIn("Copy endpoint", self.js)
        self.assertIn('body.url = url', self.js)
        self.assertIn('$("endpoint-url").value = hit.url', self.js)
        self.assertIn("original URL and query encoding are preserved", self.catalog)
        self.assertIn("does not change your required network", self.catalog)

    def test_builder_binding_default_is_explicit(self):
        inputs = {attrs.get("id"): attrs for tag, attrs in _parse(self.catalog).nodes if tag == "input"}
        self.assertIn("checked", inputs["require-binding"])
        self.assertIn("body.require_route_binding = true", self.js)
        self.assertIn("flag alone does not enforce wallet policy", self.catalog)
        self.assertIn("will reject an unbound response", self.js)

    def test_builder_subcent_fields_distinguish_invalid_and_absent(self):
        inputs = {attrs.get("id"): attrs for tag, attrs in _parse(self.catalog).nodes if tag == "input"}
        for id_ in ("max-price", "max-total-cost", "max-latency", "min-observations"):
            self.assertEqual(inputs[id_]["type"], "text")
            self.assertIn(inputs[id_]["inputmode"], ("decimal", "numeric"))
            self.assertIn(id_ + "-error", inputs[id_]["aria-describedby"])
        for phrase in ("parsed.error", "valid = false", '$("copy-route-json").disabled = !valid', '$("copy-route-curl").disabled = !valid', "Number.isSafeInteger", "up to 6 decimals", 'return { absent: true }'):
            self.assertIn(phrase, self.js)
        self.assertNotIn("Math.floor(n)", self.js)

    def test_builder_schema_field_mapping_remains_supported(self):
        from live402 import schema_fields
        props = schema_fields.route_body_schema()["properties"]
        for key in ("url", "need", "networks", "max_price_usd", "require_invocable", "min_observations", "objective", "prefer_network", "max_total_cost_usd", "max_latency_ms", "search_depth", "require_route_binding"):
            self.assertIn(key, props)
            self.assertIn(key, self.js)
        self.assertNotIn("body.network =", self.js)
        self.assertIn("&networks=", self.js)
        self.assertIn("&prefer_network=", self.js)

    def test_cost_and_latency_scope_are_explicit(self):
        text = _text(self.catalog)
        for phrase in ("Maximum seller price (USD)", "excludes the separate $0.003 routing fee", "not a whole-wallet budget", "This is not settlement latency", "Unknown required cost components fail closed"):
            self.assertIn(phrase, text)
        self.assertIn("not an additional enforced wallet limit", self.js)

    def test_catalog_never_submits_payment_or_customer_credentials(self):
        self.assertIn("This page builds the request but does not submit or charge it.", self.catalog)
        for phrase in ("window.ethereum", "WalletConnect", 'fetch("/route"', 'fetch("/validate"', "localStorage", "sessionStorage", "innerHTML"):
            self.assertNotIn(phrase, self.js)
        self.assertIn('credentials: "omit"', self.js)
        self.assertIn('redirect: "error"', self.js)
        self.assertIn("A share link may prefill a capability, never policies or credentials", self.js)
        self.assertIn("shellSingleQuote(compact)", self.js)

    def test_search_has_resource_and_concurrency_bounds(self):
        for phrase in ("AbortController", "controller.abort()", "sequence !== state.sequence", "MAX_RESPONSE", "reader.cancel()", "query.length > 300", "parsed.hits.length > 200", 'setAttribute("aria-busy", "false")', "invalidateSearch"):
            self.assertIn(phrase, self.js)
        for phrase in ("Too many searches", "unavailable or refreshing", "Search timed out", "Could not load the catalog", "No catalog matches found"):
            self.assertIn(phrase, self.js)

    def test_toggle_selection_and_keyboard_focus_are_distinct(self):
        self.assertNotIn('role="radiogroup"', self.catalog)
        for group in ("network-chips", "prefer-chips", "objective-chips", "depth-chips"):
            match = re.search(r'id="%s"[^>]*>(.*?)</div>' % group, self.catalog, re.S)
            self.assertIsNotNone(match)
            self.assertEqual(match.group(1).count('aria-pressed="true"'), 1)
        self.assertIn("button:focus-visible", self.css)
        self.assertIn('.chip[aria-pressed="true"]', self.css)
        self.assertNotIn(".blur()", self.js)

    def test_browser_regressions_are_real_geometry_and_flow_checks(self):
        browser = ROOT.joinpath("integration/website/browser.mjs").read_text()
        for phrase in ("chromium", "webkit", "320", "390", "1440", "getBoundingClientRect", "scrollWidth", "isDisabled", "copiedFixtureText", "sellerInjected"):
            self.assertIn(phrase, browser)
        self.assertNotIn("overflow-x: hidden", self.css)
        self.assertIn("min-width: 0", self.css)
        self.assertIn("prefers-reduced-motion", self.css)
        self.assertIn("font-size: 16px", self.css)

    def test_installation_and_runtime_requirements_are_not_hidden(self):
        for phrase in ("Node.js 22 or newer", "Node 24", "POSIX", "not an npm registry release", "sha256sum --check SHA256SUMS", "npm install ./402signal-route-guard-0.5.0.tgz", "PUBLIC TEST KEY", "No networking, signing or payment occurs"):
            self.assertIn(phrase, _text(self.devs))
        self.assertIn("verifyRoute", self.devs)
        self.assertIn("tests/fixtures/route-binding-v1.json", self.devs)

    def test_guard_requires_independent_pins_and_actual_buyer_enforcement(self):
        for phrase in ("withVerifiedRoute", "independent trusted configuration", "default observation window is 60 seconds", "transaction effects", "prevent duplicate seller sends", "does not guarantee delivery or output quality"):
            self.assertIn(phrase, _text(self.devs))
        self.assertIn("scaffolding, not complete wallet code", _text(self.devs))
        self.assertIn("Historical integrity verification does not extend", self.devs)

    def test_billing_and_recovery_cannot_be_mistaken_for_a_retry(self):
        for phrase in ("HTTP 402", "HTTP 200", "HTTP 503", "live:false", "payable:false", "selected_payment:null", "billing.settlement_state=not_attempted", "client.recover(attemptId)", "Do not reuse an unknown authorization", "unread response is not proof", "same attempt", "not MCP"):
            self.assertIn(phrase, _text(self.devs))
        self.assertIn("they are not customer wallet keys", _text(self.devs))
        self.assertIn("Do not generate another payment", self.devs)

    def test_mcp_free_and_paid_transport_boundaries(self):
        for phrase in ("preview", "validate", "route", "catalog-listed HTTPS", "Glama stdio adapter", "cannot sign, forward payment headers or complete a paid route", "not the advertised MCP input schema"):
            self.assertIn(phrase, _text(self.devs))
        for href in ("/openapi.json", "/mcp.json", "/llms.txt"):
            self.assertIn(href, [href for _, href in _parse(self.devs).links])
        for _, href in _parse(self.devs).links:
            self.assertNotIn(href.rstrip("/"), ("/route", "/validate", "/mcp", "https://402signal.com/mcp"))

    def test_policy_owner_boundaries_are_explicit(self):
        for phrase in ("Keep enforceable policy outside the model", "Trusted application code", "not a permanent organization-wide recipient allowlist", "no hosted approval queue", "not a throughput certification"):
            self.assertIn(phrase, _text(self.devs))
        self.assertIn('id="policy-guide"', self.devs)
        self.assertIn('id="data-boundary"', self.how)
        self.assertNotIn("payment/data never passes through", self.home + self.how)

    def test_private_evidence_retention_is_not_the_public_log(self):
        for phrase in ("Store your verification record securely", "check its integrity later"):
            self.assertIn(phrase, self.home)
        for phrase in ("Keep the verification record", "pq_trust.transparency.receipt", "pq_trust.transparency.reveal", "do not put it in public logs", "Private replay outcomes can retain", "not a long-term evidence backup"):
            self.assertIn(phrase, self.devs)
        self.assertIn("private verification record", self.how)
        self.assertIn("not a backup", self.how)
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

    def test_mainnet_pending_and_seller_payment_scope(self):
        self.assertIn("Awaiting anchor", self.home)
        self.assertIn("Pending records are not yet confirmed on-chain", self.home)
        for phrase in ("Ed25519", "Falcon-1024", "The route call does not wait for chain confirmation", "It does not authorize or secure the seller payment"):
            self.assertIn(phrase, self.devs)
        self.assertIn("e6b81414", self.transparency)
        self.assertIn("Historical TestNet archive", self.transparency)
        self.assertIn("It does not make seller payments on Base, Solana, or Algorand post-quantum secure", self.transparency)
        self.assertNotIn("Currently Algorand TestNet", self.home + self.devs + self.transparency)

    def test_transparency_does_not_collect_private_customer_records(self):
        self.assertNotIn("<form", self.transparency)
        for phrase in ("Public transparency commitments do not expose raw needs, wallets, payment signatures, or seller response bodies.", "What is published?", "What the checkpoint proves", "Later changes to that earlier history become detectable."):
            self.assertIn(phrase, self.transparency)
        self.assertNotIn("customer-search", self.transparency)

    def test_each_page_has_one_heading_title_and_unique_ids(self):
        for path, html in self.pages.items():
            with self.subTest(path=path):
                doc = _parse(html)
                self.assertEqual(len(doc.h1), 1)
                self.assertEqual(len(doc.title), 1)
                self.assertEqual(len(doc.ids), len(set(doc.ids)))
                self.assertIn('name="viewport"', html)
                self.assertIn("width=device-width", html)
        self.assertEqual(_parse(self.home).h1, ["Check the offer before your agent pays."])
        self.assertEqual(_parse(self.catalog).title, ["Explore paid APIs · 402Signal"])

    def test_primary_navigation_and_shared_chrome(self):
        self.assertEqual(site_chrome.NAV, tuple(zip(NAV_HREFS, NAV_LABELS)))
        for path, html in self.pages.items():
            with self.subTest(path=path):
                self.assertEqual(_parse(html).nav_links, list(zip(NAV_LABELS, NAV_HREFS)))
                self.assertIn('class="mark"', html)
                self.assertIn('class="brand-name"', html)
                self.assertIn("402Signal", html)

    def test_contact_security_and_license_are_reachable_everywhere(self):
        for path, html in self.pages.items():
            hrefs = [href for _, href in _parse(html).links]
            for href, _, _ in site_chrome.FOOTER:
                self.assertIn(href, hrefs, (path, href))
            self.assertIn("ross@402signal.com", html)
            self.assertNotIn("402signal@gmail.com", html)
        contact = self.pages["/contact"]
        self.assertIn("Please keep sensitive details out of public issues.", contact)
        self.assertIn("Do not send private keys", contact)
        self.assertIn("/.well-known/security.txt", contact)

    def test_public_listings_are_not_endorsements(self):
        for href, label in site_chrome.LISTED_ON:
            self.assertIn((label, href), _parse(self.home).links)
        self.assertIn("Directory listings are not endorsements.", self.home)
        for path, html in self.pages.items():
            if path != "/":
                self.assertNotIn('class="listed-on"', html)

    def test_local_anchor_links_resolve(self):
        for path, html in self.pages.items():
            for _, href in _parse(html).links:
                parts = urlsplit(href)
                if parts.scheme or not parts.fragment:
                    continue
                target = parts.path or path
                if target in self.pages:
                    self.assertIn(parts.fragment, _parse(self.pages[target]).ids, (path, href))

    def test_semantic_labels_local_assets_and_no_inline_code(self):
        for path, html in self.pages.items():
            doc = _parse(html)
            for tag, attrs in doc.nodes:
                self.assertFalse(any(key.lower().startswith("on") for key in attrs), (path, tag))
                if tag == "script":
                    self.assertTrue(attrs.get("src", "").startswith("/"), (path, attrs))
                if tag == "a":
                    self.assertFalse(attrs.get("href", "").lower().startswith("javascript:"))
            if path not in ("/dashboard", "/transparency"):
                self.assertIn("Skip to content", html)
        labels = {attrs["for"] for tag, attrs in _parse(self.catalog).nodes if tag == "label" and "for" in attrs}
        for id_ in ("need", "endpoint-url", "max-price", "min-observations", "max-total-cost", "max-latency", "display-filter", "display-sort"):
            self.assertIn(id_, labels)

    def test_no_em_dash_or_overclaim_language(self):
        for path, html in self.pages.items():
            self.assertNotIn("\N{EM DASH}", html, path)
            for phrase in BANNED:
                self.assertNotIn(phrase, html, (path, phrase))
        for name in ("index.html", "catalog.html", "how.html", "developers.html", "contact.html", "route.html", "pre-spend-routing.html", "app.js", "dashboard.js", "transparency.js"):
            self.assertNotIn("\N{EM DASH}", _read(name), name)

    def test_metadata_and_source_styles_are_versioned_at_runtime(self):
        from live402 import asset_version
        version = asset_version.asset_version()
        self.assertTrue(version)
        for path, html in self.pages.items():
            self.assertIn("/styles.css?v=" + version, html, path)
            self.assertNotIn('href="/styles.css"', html, path)
            self.assertNotIn("FLY_IMAGE_REF", html, path)
        for path in ("/catalog", "/how"):
            self.assertIn("/app.js?v=" + version, self.pages[path])
        self.assertIn("/transparency.js?v=" + version, self.transparency)
        self.assertIn("/dashboard.js?v=" + version, self.pages["/dashboard"])
        for name in ("index.html", "catalog.html", "how.html", "developers.html", "contact.html"):
            self.assertIn('href="/styles.css"', _read(name))
            self.assertNotIn("?v=", _read(name))
        self.assertIn('rel="canonical" href="https://402signal.com/"', self.home)
        self.assertIn('property="og:image" content="https://402signal.com/og.png"', self.home)

    def test_human_pages_keep_the_original_csp(self):
        expected = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"
        self.assertEqual(CSP, expected)
        for path in self.pages:
            status, html, headers = _get_full(self.port, path, {"Accept": "text/html"})
            self.assertEqual(status, 200)
            self.assertTrue(html.strip())
            self.assertIn("text/html", headers["content-type"])
            self.assertEqual(headers.get("content-security-policy"), expected)

    def test_machine_interfaces_and_unpaid_route_are_preserved(self):
        for path in ("/preview?need=weather", "/openapi.json", "/mcp.json", "/.well-known/x402.json", "/rails", "/pulse", "/llms.txt"):
            status, raw, _ = _get_full(self.port, path)
            self.assertEqual(status, 200, path)
            self.assertTrue(raw.strip(), path)
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

    def test_cache_contract_and_path_traversal_defense(self):
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

    def test_sitemap_security_contact_and_human_404(self):
        for path in ("/favicon.svg", "/sitemap.xml", "/.well-known/security.txt", "/.well-known/x402list.txt"):
            status, raw, _ = _get_full(self.port, path)
            self.assertEqual(status, 200)
            self.assertTrue(raw)
        token = _get_full(self.port, "/.well-known/x402list.txt")[1]
        self.assertEqual(token, "x402list-verify-52dmS9yTO-vP6AMJh6H8mZZBInntQZP7zSLPF806CnQ\n")
        self.assertGreater((STATIC / "og.png").stat().st_size, 10000)
        self.assertGreater((STATIC / "hero-routing.png").stat().st_size, 10000)
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
