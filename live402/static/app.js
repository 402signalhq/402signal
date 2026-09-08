/* Customer-facing discovery and request construction. Never signs or pays. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const el = (tag, cls, value) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value != null) node.textContent = String(value);
    return node;
  };
  const setText = (id, value) => { if ($(id)) $(id).textContent = value; };
  async function copy(value, button, label) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
      else {
        const field = el("textarea", "", value);
        document.body.appendChild(field);
        field.select();
        const ok = document.execCommand("copy");
        field.remove();
        if (!ok) throw new Error("copy unavailable");
      }
      button.textContent = "Copied";
    } catch (_) { button.textContent = "Copy failed; select the text below"; }
    window.setTimeout(() => { button.textContent = label; }, 2200);
  }

  // This illustrative state machine never calls the service or a wallet.
  if ($("demo-scenario")) {
    const scenarios = {
      same: ["$0.020 USDC", "Seller A", "Within the sample window", "Offer matches", "The local guard could pass control to your buyer. Your wallet still validates the transaction and budget.", "$0.003", "No payment in this demonstration"],
      price: ["$0.030 USDC", "Seller A", "Within the sample window", "Stop: price changed", "The current price differs from the recorded offer. The guard does not call your signing code.", "$0.003", "Signing callback not called"],
      recipient: ["$0.020 USDC", "Seller B", "Within the sample window", "Stop: recipient changed", "The destination differs from the recorded offer. The guard does not call your signing code.", "$0.003", "Signing callback not called"],
      expired: ["$0.020 USDC", "Seller A", "Expired", "Stop: evidence expired", "The observation is too old for a new purchase. Do not treat historical verification as permission to sign.", "$0.003", "Signing callback not called"],
      miss: ["$0.030 USDC", "Seller A", "Initial check", "No qualifying offer", "The initial offer exceeds the $0.020 rule. This completed no-match check would not settle the routing fee.", "$0", "No seller purchase"],
    };
    function renderDemo() {
      const key = $("demo-scenario").value;
      const data = scenarios[key] || scenarios.same;
      ["demo-price", "demo-recipient", "demo-age", "demo-result", "demo-reason", "demo-fee", "demo-wallet"].forEach((id, i) => setText(id, data[i]));
      $("demo-output").dataset.outcome = key === "same" ? "match" : "stop";
    }
    $("demo-scenario").addEventListener("change", renderDemo);
    renderDemo();
  }
  if (!$("search-form")) return;

  const RAILS = { base: "Base", solana: "Solana", algorand: "Algorand" };
  const state = { network: "any", prefer: "any", objective: "best", depth: "standard", hits: [], result: null, sequence: 0, controller: null };
  const numericFields = [["max-price", "max_price_usd", false], ["min-observations", "min_observations", true], ["max-total-cost", "max_total_cost_usd", false], ["max-latency", "max_latency_ms", true]];
  const MAX_RESPONSE = 1048576;
  const boundedText = (value, max = 400) => typeof value === "string" ? value.slice(0, max) : "";
  function httpsURL(value) {
    try {
      if (typeof value !== "string" || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password && !u.hash;
    } catch (_) { return false; }
  }
  function mode() { return document.querySelector('input[name="target-mode"]:checked').value; }
  function fieldError(id, error) {
    const input = $(id);
    input.setAttribute("aria-invalid", error ? "true" : "false");
    setText(id === "endpoint-url" ? "endpoint-error" : id + "-error", error || "");
  }
  function numberValue(id, integer) {
    const raw = $(id).value.trim();
    if (!raw) { fieldError(id, ""); return { absent: true }; }
    const pattern = integer ? /^\d+$/ : /^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/;
    let ok = pattern.test(raw);
    const n = Number(raw);
    ok = ok && Number.isFinite(n) && n >= 0 && (integer ? Number.isSafeInteger(n) : n <= Number.MAX_SAFE_INTEGER / 1000000);
    fieldError(id, ok ? "" : (integer ? "Use a whole number of zero or more. Do not use exponents." : "Use a nonnegative amount with up to 6 decimals. Do not use exponents."));
    return ok ? { value: n } : { error: true };
  }
  function buildRouteBody() {
    const body = {};
    let valid = true;
    const q = $("need").value.trim();
    if (mode() === "url") {
      const url = $("endpoint-url").value.trim();
      const ok = httpsURL(url);
      fieldError("endpoint-url", ok || !url ? "" : "Use an exact HTTPS URL without credentials, spaces or a fragment.");
      valid = ok;
      if (ok) body.url = url; // Do not normalize the request URL or its encoding.
    } else {
      fieldError("endpoint-url", "");
      valid = q.length > 0 && q.length <= 300;
      if (valid) body.need = q;
    }
    if (state.network !== "any") body.networks = [state.network];
    for (const [id, key, integer] of numericFields) {
      const parsed = numberValue(id, integer);
      if (parsed.error) valid = false;
      else if (!parsed.absent) body[key] = parsed.value;
    }
    if ($("require-invocable").checked) body.require_invocable = true;
    if ($("require-binding").checked) body.require_route_binding = true;
    if (state.objective !== "best") body.objective = state.objective;
    if (state.prefer !== "any") body.prefer_network = state.prefer;
    if (state.depth === "thorough") body.search_depth = "thorough";
    return { body, valid };
  }
  function shellSingleQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
  function routeCurl(body) { return "curl -sS -D - https://402signal.com/route -H 'Content-Type: application/json' --data " + shellSingleQuote(JSON.stringify(body)); }
  function syncBuilder() {
    $("endpoint-field").hidden = mode() !== "url";
    $("search-btn").disabled = !$("need").value.trim();
    const { body, valid } = buildRouteBody();
    $("copy-route-json").disabled = !valid;
    $("copy-route-curl").disabled = !valid;
    setText("binding-help", $("require-binding").checked ? "Adds require_route_binding=true. Your application must also integrate the local guard before its own wallet signs; the flag alone does not enforce wallet policy." : "Signed binding is off. The local buyer guard will reject an unbound response. This is not the guarded integration path.");
    const message = "Enter a capability or exact endpoint and correct any highlighted limits. No request is ready to copy.";
    setText("route-json", valid ? JSON.stringify(body, null, 2) : message);
    setText("route-curl", valid ? routeCurl(body) : "");
    setText("policy-summary", valid ? (body.url ? "Check this exact endpoint" : "Discover a matching capability") + " on " + (body.networks ? RAILS[body.networks[0]] : "any supported network") + ". No payment is made by this page." : message);
    const facts = $("policy-facts"); facts.replaceChildren();
    if (valid) {
      facts.appendChild(el("p", "", "402Signal fee: $0.003 only when an offer qualifies. Seller payment and network costs are separate."));
      if (body.max_price_usd != null) {
        const combined = ((Math.round(body.max_price_usd * 1000000) + 3000) / 1000000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
        facts.appendChild(el("p", "", "At the seller-price cap: $" + combined + " including the checking fee, before network fees. This display is not an additional enforced wallet limit."));
      }
    }
  }
  function selectEndpoint(hit) {
    if (!httpsURL(hit.url)) return;
    document.querySelector('input[name="target-mode"][value="url"]').checked = true;
    $("endpoint-url").value = hit.url;
    syncBuilder();
    $("request-builder").scrollIntoView({ block: "start", behavior: "auto" });
    $("endpoint-url").focus({ preventScroll: true });
  }
  function previewUrl() {
    let url = "/preview?need=" + encodeURIComponent($("need").value.trim());
    if (state.network !== "any") url += "&networks=" + encodeURIComponent(state.network);
    if (state.prefer !== "any") url += "&prefer_network=" + encodeURIComponent(state.prefer);
    return url;
  }
  async function readJSON(response) {
    const reader = response.body && response.body.getReader();
    if (!reader) throw new Error("unreadable");
    let size = 0;
    const parts = [];
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error("too_large"); }
        parts.push(item.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("unreadable");
    return result;
  }
  function observation(hit) {
    const obs = hit.observation;
    return obs && typeof obs === "object" && obs.status !== "not_yet_observed" ? obs : null;
  }
  function observedTime(hit) {
    const obs = observation(hit);
    const raw = obs && obs.last_checked;
    if (typeof raw !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) && t <= Date.now() + 60000 ? t : null;
  }
  function ageLabel(time) {
    if (time == null) return "Observation time unavailable";
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return "Last observed less than a minute ago";
    const [count, unit] = seconds < 3600 ? [Math.floor(seconds / 60), "minute"] : seconds < 86400 ? [Math.floor(seconds / 3600), "hour"] : [Math.floor(seconds / 86400), "day"];
    return "Last observed " + count + " " + unit + (count === 1 ? "" : "s") + " ago";
  }
  function listedFixedPrice(hit) {
    if (hit.scheme && hit.scheme !== "exact") return null;
    const raw = typeof hit.price === "string" ? hit.price.trim() : "";
    if (!/^\$\d+(?:\.\d{1,6})?(?: USD)?$/.test(raw)) return null;
    const n = Number(raw.replace(/^\$/, "").replace(/ USD$/, ""));
    return Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER / 1000000 ? n : null;
  }
  function hasSchema(hit) { return hit.inputSchema_present === true || (hit.claimed && hit.claimed.schema_present === true); }
  function fact(dl, label, value) {
    const row = el("div", ""); row.append(el("dt", "", label), el("dd", "", value)); dl.appendChild(row);
  }
  function renderHit(hit) {
    const card = el("article", "panel result-row");
    let hostname = "Endpoint";
    try { hostname = new URL(hit.url).hostname; } catch (_) {}
    const label = boundedText(hit.label || hit.serviceName || hit.name || hit.need, 160) || hostname;
    card.appendChild(el("h2", "result-name", label));
    const url = el("p", "result-url mono wrap", boundedText(hit.url, 4096)); card.appendChild(url);
    const sides = el("div", "result-sides");
    const claims = el("section", "result-side"); claims.appendChild(el("h3", "result-side-label", "Seller says"));
    const dl = el("dl", "checks compact");
    fact(dl, "Listed price / terms", boundedText(hit.price, 180) || "Not supplied; do not assume free");
    const rail = typeof hit.chain === "string" ? hit.chain : typeof hit.network === "string" ? hit.network : "";
    fact(dl, "Network", RAILS[rail] || boundedText(rail, 120) || "Not supplied");
    fact(dl, "Request", boundedText(hit.method, 12) || "Method not listed");
    fact(dl, "Input schema listed", hasSchema(hit) ? "Yes; seller-supplied metadata" : "Not listed or unknown");
    claims.appendChild(dl);
    const seen = el("section", "result-side"); seen.appendChild(el("h3", "result-side-label", "Previously observed"));
    const obs = observation(hit);
    if (!obs) seen.appendChild(el("p", "", "No prior 402Signal observation"));
    else {
      const t = observedTime(hit);
      const stamp = el("p", "", ageLabel(t));
      if (t != null) stamp.title = new Date(t).toISOString();
      seen.appendChild(stamp);
      const previous = el("dl", "checks compact");
      fact(previous, "Payment offer", obs.payable === true ? "Payable at that check" : obs.payable === false ? "Not payable at that check" : "Unknown");
      fact(previous, "Invocation metadata", obs.invocable === true ? "Sufficient at that check" : obs.invocable === false ? "Insufficient at that check" : "Unknown");
      if (typeof obs.n_7d === "number" && Number.isSafeInteger(obs.n_7d) && obs.n_7d >= 0) fact(previous, "Observations in the last 7 days", obs.n_7d);
      if (typeof obs.last_latency_ms === "number" && Number.isFinite(obs.last_latency_ms) && obs.last_latency_ms >= 0) fact(previous, "Last HTTP probe time", obs.last_latency_ms + " ms; not settlement time");
      seen.appendChild(previous);
    }
    seen.appendChild(el("p", "policy-hint", "Historical evidence, not current availability or output quality."));
    sides.append(claims, seen); card.appendChild(sides);
    const details = el("details", "policy-advanced"); details.appendChild(el("summary", "", "Listing source and limitations"));
    details.appendChild(el("p", "", "Source: " + (boundedText(hit.source || (hit.claimed && hit.claimed.source), 180) || "Not provided in this response")));
    if (hit.facilitator) details.appendChild(el("p", "mono wrap", "Listed facilitator: " + boundedText(hit.facilitator, 500)));
    details.appendChild(el("p", "policy-hint", "Seller names, terms and schemas are untrusted catalog data. A current constrained check can return a different result. Capability matches do not guarantee interchangeable outputs."));
    card.appendChild(details);
    const actions = el("div", "hero-actions");
    const choose = el("button", "btn", "Check this endpoint"); choose.type = "button"; choose.disabled = !httpsURL(hit.url); choose.addEventListener("click", () => selectEndpoint(hit));
    const copyURL = el("button", "copy-btn", "Copy endpoint"); copyURL.type = "button"; copyURL.disabled = !httpsURL(hit.url); copyURL.addEventListener("click", () => copy(hit.url, copyURL, "Copy endpoint"));
    actions.append(choose, copyURL); card.appendChild(actions);
    card.appendChild(el("p", "policy-hint", "Builds a request only. No purchase or wallet connection."));
    return card;
  }
  function renderResults() {
    const results = $("search-results"); results.replaceChildren();
    const filter = $("display-filter").value;
    let hits = state.hits.filter(hit => filter === "all" || (filter === "observed" ? observation(hit) != null : hasSchema(hit)));
    const sort = $("display-sort").value;
    hits = hits.map((hit, index) => ({ hit, index })).sort((a, b) => {
      if (sort === "recent") return (observedTime(b.hit) || 0) - (observedTime(a.hit) || 0) || a.index - b.index;
      if (sort === "price") {
        const x = listedFixedPrice(a.hit), y = listedFixedPrice(b.hit);
        return x == null ? (y == null ? a.index - b.index : 1) : y == null ? -1 : x - y || a.index - b.index;
      }
      return a.index - b.index;
    }).map(row => row.hit);
    const observed = state.hits.filter(hit => observation(hit) != null).length;
    setText("catalog-summary", state.hits.length + " listings returned · " + observed + " with prior observations · " + hits.length + " shown");
    if (state.result && Number.isSafeInteger(state.result.discovery_matches) && state.result.discovery_matches > state.hits.length) {
      results.appendChild(el("p", "policy-hint", state.result.discovery_matches + (state.result.discovery_exhaustive === true ? " discovery matches; this response is a subset." : " matches returned by discovery; coverage is not exhaustive.")));
    }
    if (!hits.length) results.appendChild(el("p", "empty-state", state.hits.length ? "No returned listings meet this display filter. Change the filter; your spending rules have not changed." : "No catalog matches found. Try a broader capability."));
    for (const hit of hits) results.appendChild(renderHit(hit));
  }
  async function runSearch() {
    if (!$("need").value.trim()) return;
    const sequence = ++state.sequence;
    if (state.controller) state.controller.abort();
    const controller = new AbortController(); state.controller = controller;
    const timer = window.setTimeout(() => controller.abort(), 20000);
    state.hits = []; state.result = null;
    $("search-results").replaceChildren(); $("result-controls").hidden = true;
    $("search-results").setAttribute("aria-busy", "true");
    setText("search-status", "Searching catalog...");
    try {
      const response = await fetch(previewUrl(), { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
      if (sequence !== state.sequence) return;
      if (!response.ok) {
        const message = response.status === 429 ? "Too many searches. Wait before trying again; your filters are preserved." : response.status === 400 ? "The catalog could not accept this search. Check the capability and network." : response.status === 502 || response.status === 503 ? "Catalog data is unavailable or refreshing. No payment was made." : "Catalog request failed (HTTP " + response.status + "). No payment was made.";
        throw new Error(message);
      }
      const parsed = await readJSON(response);
      if (sequence !== state.sequence) return;
      if (!Array.isArray(parsed.hits) || parsed.hits.length > 200) throw new Error("The catalog returned an unreadable response. No payment was made.");
      state.hits = parsed.hits.filter(hit => hit && typeof hit === "object" && !Array.isArray(hit));
      state.result = parsed;
      $("result-controls").hidden = state.hits.length === 0;
      renderResults(); setText("search-status", "Catalog response received. Endpoints have not been rechecked.");
    } catch (error) {
      if (sequence !== state.sequence) return;
      const known = typeof error.message === "string" && /^(Too many searches|The catalog|Catalog request|Catalog data)/.test(error.message);
      setText("search-status", controller.signal.aborted ? "Search timed out. Try again; no payment was made." : known ? error.message : "Could not load the catalog. Check your connection and try again; no payment was made.");
    } finally {
      window.clearTimeout(timer);
      if (sequence === state.sequence) $("search-results").setAttribute("aria-busy", "false");
    }
  }
  function group(id, attr, key, values) {
    $(id).addEventListener("click", event => {
      const button = event.target.closest("button[" + attr + "]");
      if (!button || !$(id).contains(button)) return;
      const value = button.getAttribute(attr); if (!values.includes(value)) return;
      state[key] = value;
      for (const item of $(id).querySelectorAll("button")) { item.classList.toggle("active", item === button); item.setAttribute("aria-pressed", item === button ? "true" : "false"); }
      syncBuilder();
      if (key === "network" || key === "prefer") {
        ++state.sequence; if (state.controller) state.controller.abort();
        state.hits = []; state.result = null; $("search-results").replaceChildren(); $("result-controls").hidden = true;
        setText("search-status", "Network selection changed. Search again to refresh listings.");
      }
    });
  }
  group("network-chips", "data-network", "network", ["any", "base", "solana", "algorand"]);
  group("prefer-chips", "data-prefer", "prefer", ["any", "base", "solana", "algorand"]);
  group("objective-chips", "data-objective", "objective", ["best", "cheapest", "fastest", "most_reliable"]);
  group("depth-chips", "data-depth", "depth", ["standard", "thorough"]);
  $("search-form").addEventListener("submit", event => { event.preventDefault(); runSearch(); });
  $("need-chips").addEventListener("click", event => { const button = event.target.closest("button[data-need]"); if (button) { $("need").value = button.dataset.need; syncBuilder(); runSearch(); } });
  for (const id of ["need", "endpoint-url", "require-invocable", "require-binding", ...numericFields.map(row => row[0])]) $(id).addEventListener("input", syncBuilder);
  for (const radio of document.querySelectorAll('input[name="target-mode"]')) radio.addEventListener("change", syncBuilder);
  for (const id of ["display-filter", "display-sort"]) $(id).addEventListener("change", renderResults);
  for (const [id, format, label] of [["copy-route-json", "json", "Copy JSON"], ["copy-route-curl", "curl", "Copy curl"]]) $(id).addEventListener("click", () => { const { body, valid } = buildRouteBody(); syncBuilder(); if (valid) copy(format === "json" ? JSON.stringify(body, null, 2) : routeCurl(body), $(id), label); });
  const query = new URLSearchParams(window.location.search);
  const initialNeed = query.get("need");
  // Only a capability is accepted from a share link. Never import spending limits or credentials.
  if (initialNeed && initialNeed.length <= 300) $("need").value = initialNeed;
  syncBuilder();
})();
