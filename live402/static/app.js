/* Customer discovery, documentation and unpaid readiness. Never signs or pays. */
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
        document.body.appendChild(field); field.select();
        const ok = document.execCommand("copy"); field.remove();
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
      const key = $("demo-scenario").value, data = scenarios[key] || scenarios.same;
      ["demo-price", "demo-recipient", "demo-age", "demo-result", "demo-reason", "demo-fee", "demo-wallet"].forEach((id, i) => setText(id, data[i]));
      $("demo-output").dataset.outcome = key === "same" ? "match" : "stop";
    }
    $("demo-scenario").addEventListener("change", renderDemo); renderDemo();
  }
  // All task guides remain readable without JavaScript. This narrows the view.
  const guidePanels = [...document.querySelectorAll('[data-guide]')];
  if (guidePanels.length) {
    const aliases = {request: 'route-binding'};
    function showGuide(moveFocus = false) {
      let hash;
      try { hash = decodeURIComponent(location.hash.slice(1)); } catch (_) { hash = ''; }
      const id = aliases[hash] || hash || 'quickstart';
      const target = guidePanels.find(panel => panel.id === id || panel.querySelector('[id="' + CSS.escape(id) + '"]'));
      for (const panel of guidePanels) panel.hidden = Boolean(target) && panel !== target;
      for (const link of document.querySelectorAll('[data-guide-link]')) {
        if (target && link.dataset.guideLink === target.id) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
      setText('guide-status', target ? 'Showing ' + target.querySelector('h2').textContent : 'Showing all guides.');
      if (moveFocus && target) {
        target.scrollIntoView({block: 'start', behavior: 'auto'});
        target.focus({preventScroll: true});
      }
    }
    for (const link of document.querySelectorAll('[data-guide-link]')) {
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (location.hash === '#' + link.dataset.guideLink) showGuide(true);
        else location.hash = link.dataset.guideLink;
      });
    }
    window.addEventListener('hashchange', () => showGuide(true)); showGuide();
  }
  for (const button of document.querySelectorAll('[data-copy-target]')) {
    const target = $(button.dataset.copyTarget);
    if (!target) continue;
    button.disabled = false;
    const label = button.textContent;
    button.addEventListener('click', () => copy(target.textContent, button, label));
  }
  // Existing listed-endpoint validation only. No arbitrary probe or payment path.
  if ($('seller-form')) {
    let generation = 0, active = null;
    function sellerURL(value) {
      try {
        if (!value.startsWith('https://') || value.length > 4096 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
      } catch (_) { return false; }
    }
    function clearSeller() {
      ++generation; if (active) active.abort();
      $('seller-result').replaceChildren();
      setText('seller-json', 'No check has run for this input.');
      setText('seller-status', 'Submit to check this exact catalog-listed endpoint. No payment is made.');
      $('seller-check').disabled = !sellerURL($('seller-url').value.trim());
      $('seller-result').setAttribute('aria-busy', 'false');
    }
    async function sellerJSON(response) {
      if (!response.body) throw new Error('unreadable');
      const reader = response.body.getReader(), parts = [];
      let length = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          length += item.value.byteLength;
          if (length > 262144) { await reader.cancel(); throw new Error('unreadable'); }
          parts.push(item.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      const result = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('unreadable');
      return result;
    }
    $('seller-url').addEventListener('input', clearSeller);
    const candidate = new URLSearchParams(location.search).get('endpoint');
    if (candidate && sellerURL(candidate)) $('seller-url').value = candidate;
    clearSeller();
    $('seller-form').addEventListener('submit', async event => {
      event.preventDefault();
      const exact = $('seller-url').value.trim();
      if (!sellerURL(exact)) { clearSeller(); return; }
      const ticket = ++generation; if (active) active.abort();
      const controller = new AbortController(); active = controller;
      const timer = setTimeout(() => controller.abort(), 20000);
      $('seller-result').replaceChildren(); $('seller-result').setAttribute('aria-busy','true');
      setText('seller-json', 'Waiting for this check.');
      setText('seller-status', 'Checking listed-endpoint readiness...');
      try {
        const response = await fetch('/validate?url=' + encodeURIComponent(exact), {credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
        if (ticket !== generation) return;
        if (!response.ok) throw new Error(response.status === 429 ? 'limited' : response.status === 400 ? 'invalid' : 'unavailable');
        const result = await sellerJSON(response);
        if (ticket !== generation) return;
        if (result.url !== exact) throw new Error('unreadable');
        setText('seller-json', JSON.stringify(result, null, 2));
        if (result.miss_reason === 'unlisted' || result.miss_reason === 'no_candidates') {
          setText('seller-status', 'Not in the local catalog. No seller probe was made. This does not show that the endpoint is offline.');
        } else if (result.miss_reason === 'ssrf') {
          setText('seller-status', 'The destination was refused by the service safety checks. No broader scan was attempted.');
        } else {
          setText('seller-status', 'Readiness response received. This was not a purchase or a settlement test.');
          const list = el('dl','checks compact');
          const observed = result.observed && typeof result.observed === 'object' ? result.observed : {};
          const facts = [
            ['Supported offer metadata',result.payable === true ? 'Accepted by the offer parser at this check' : result.payable === false ? 'Not established at this check' : 'Unknown'],
            ['Input information',result.invocable === true ? 'Sufficient at this check' : 'Insufficient or unknown'],
            ['HTTP status',Number.isInteger(observed.http_status) ? String(observed.http_status) : 'Unknown'],
            ['Observed recipient',typeof observed.payTo === 'string' ? observed.payTo.slice(0,200) : 'Not returned'],
            ['Check timestamp',typeof result.verified_at === 'string' ? result.verified_at.slice(0,80) : 'Not returned'],
          ];
          for (const [label,value] of facts) { const row = el('div',''); row.append(el('dt','',label),el('dd','',value)); list.appendChild(row); }
          $('seller-result').appendChild(list);
          if (Array.isArray(result.flags)) $('seller-result').appendChild(el('p','note','Flags: ' + result.flags.filter(x=>typeof x==='string').slice(0,20).map(x=>x.slice(0,200)).join(', ')));
          $('seller-result').appendChild(el('p','note','Receiving-account checks, buyer compatibility, payment settlement and output quality are not established by this result.'));
        }
      } catch (error) {
        if (ticket !== generation) return;
        const messages = {limited:'Rate limit reached. Wait before checking again.', invalid:'The service could not accept that endpoint.', unavailable:'Readiness checking is unavailable. Try again later.', unreadable:'The service returned an unreadable or mismatched response.'};
        setText('seller-status', controller.signal.aborted ? 'The check timed out. No payment was made.' : (messages[error.message] || 'Could not complete the check. No payment was made.'));
        setText('seller-json','No usable response for this check.');
      } finally {
        clearTimeout(timer);
        if (ticket === generation) $('seller-result').setAttribute('aria-busy','false');
      }
    });
  }
  if (!$("search-form")) return;
  const RAILS = { base: "Base", solana: "Solana", algorand: "Algorand" };
  const state = { network: "any", prefer: "any", objective: "best", depth: "standard", hits: [], result: null, sequence: 0, controller: null };
  const numericFields = [["max-price", "max_price_usd", false], ["min-observations", "min_observations", true], ["max-total-cost", "max_total_cost_usd", false], ["max-latency", "max_latency_ms", true]];
  const MAX_RESPONSE = 1048576;
  const boundedText = (value, max = 400) => typeof value === "string" ? value.slice(0, max) : "";
  function httpsURL(value) {
    try {
      if (typeof value !== "string" || value.length > 4096 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
      const u = new URL(value);
      return value.startsWith("https://") && u.protocol === "https:" && !u.username && !u.password && !u.hash;
    } catch (_) { return false; }
  }
  function mode() { return document.querySelector('input[name="target-mode"]:checked').value; }
  function fieldError(id, error) {
    $(id).setAttribute("aria-invalid", error ? "true" : "false");
    setText(id === "endpoint-url" ? "endpoint-error" : id + "-error", error || "");
  }
  function numberValue(id, integer) {
    const raw = $(id).value.trim();
    if (!raw) { fieldError(id, ""); return { absent: true }; }
    const pattern = integer ? /^\d+$/ : /^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/;
    const n = Number(raw);
    const ok = pattern.test(raw) && Number.isFinite(n) && n >= 0 && (integer ? Number.isSafeInteger(n) : n <= Number.MAX_SAFE_INTEGER / 1000000);
    fieldError(id, ok ? "" : (integer ? "Use a whole number of zero or more. Do not use exponents." : "Use a nonnegative amount with up to 6 decimals. Do not use exponents."));
    return ok ? { value: n } : { error: true };
  }
  function buildRouteBody() {
    const body = {}; let valid = true;
    const q = $("need").value.trim();
    if (mode() === "url") {
      const url = $("endpoint-url").value.trim(), ok = httpsURL(url);
      fieldError("endpoint-url", ok || !url ? "" : "Use an exact HTTPS URL without credentials, spaces, backslashes or a fragment.");
      valid = ok; if (ok) body.url = url; // Never normalize query order or encoding.
    } else {
      fieldError("endpoint-url", ""); valid = q.length > 0 && q.length <= 300; if (valid) body.need = q;
    }
    if (state.network !== "any") body.networks = [state.network];
    for (const [id, key, integer] of numericFields) {
      const parsed = numberValue(id, integer);
      if (parsed.error) valid = false; else if (!parsed.absent) body[key] = parsed.value;
    }
    if ($("require-invocable").checked) body.require_invocable = true;
    if ($("require-binding").checked) body.require_route_binding = true;
    if (state.objective !== "best") body.objective = state.objective;
    if (state.prefer !== "any") body.prefer_network = state.prefer;
    if (state.depth === "thorough") body.search_depth = "thorough";
    return { body, valid };
  }
  function shellSingleQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
  function routeCurl(body) {
    const compact = JSON.stringify(body);
    return "curl -sS -D - https://402signal.com/route -H 'Content-Type: application/json' --data " + shellSingleQuote(compact);
  }
  function syncBuilder() {
    $("endpoint-field").hidden = mode() !== "url";
    const needLength = $("need").value.trim().length;
    $("search-btn").disabled = !needLength || needLength > 300;
    const { body, valid } = buildRouteBody();
    $("copy-route-json").disabled = !valid; $("copy-route-curl").disabled = !valid;
    setText("binding-help", $("require-binding").checked ? "Adds require_route_binding=true. Your application must also integrate the local guard before its own wallet signs; the flag alone does not enforce wallet policy." : "Signed binding is off. The local buyer guard will reject an unbound response. This is not the guarded integration path.");
    const message = "Enter a capability or exact endpoint and correct any highlighted limits. No request is ready to copy.";
    setText("route-json", valid ? JSON.stringify(body, null, 2) : message); setText("route-curl", valid ? routeCurl(body) : "");
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
    $("endpoint-url").value = hit.url; syncBuilder();
    $("request-builder").scrollIntoView({ block: "start", behavior: "auto" }); $("endpoint-url").focus({ preventScroll: true });
  }
  function previewUrl() {
    let url = "/preview?need=" + encodeURIComponent($("need").value.trim());
    if (state.network !== "any") url += "&networks=" + encodeURIComponent(state.network);
    if (state.prefer !== "any") url += "&prefer_network=" + encodeURIComponent(state.prefer);
    return url;
  }
  async function readJSON(response) {
    const reader = response.body && response.body.getReader(); if (!reader) throw new Error("unreadable");
    let size = 0; const parts = [];
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
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
    return obs && typeof obs === "object" && !Array.isArray(obs) && obs.status === "observed" ? obs : null;
  }
  function observedTime(hit) {
    const obs = observation(hit), raw = obs && obs.last_checked;
    if (typeof raw !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return null;
    const t = Date.parse(raw); return Number.isFinite(t) && t <= Date.now() + 60000 ? t : null;
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
  function hasSchema(hit) {
    if (typeof hit.inputSchema_present === "boolean") return hit.inputSchema_present;
    return Boolean(hit.claimed && hit.claimed.schema_present === true);
  }
  function safeLabel(hit) {
    let host = "Endpoint"; try { host = new URL(hit.url).hostname || host; } catch (_) {}
    const label = boundedText(hit.label || hit.serviceName || hit.name || hit.need, 160).trim();
    return !label || /^(recommended|verified|live|payable now|best for|live now|verified now|best)$/i.test(label) ? host : label;
  }
  function fact(dl, label, value) {
    const row = el("div", ""), dd = el("dd", ""), span = el("span", ""); span.textContent = value;
    dd.appendChild(span); row.append(el("dt", "", label), dd); dl.appendChild(row);
  }
  function renderHit(hit) {
    const card = el("article", "panel result-row"), name = el("h2", "result-name"); name.textContent = safeLabel(hit); card.appendChild(name);
    if (typeof hit.description === "string" && hit.description.trim()) card.appendChild(el('p', 'policy-hint', 'Seller description: ' + boundedText(hit.description, 360)));
    const urlP = el("p", "result-url mono wrap");
    if (typeof hit.url === "string" && hit.url.length <= 4096) urlP.textContent = String(hit.url);
    else urlP.textContent = "Endpoint missing or too long to construct a supported request.";
    card.appendChild(urlP);
    const sides = el("div", "result-sides"), claims = el("section", "result-side"); claims.appendChild(el("h3", "result-side-label", "Seller says"));
    const dl = el("dl", "checks compact"); fact(dl, "Listed price / terms", boundedText(hit.price, 180) || "Not supplied; do not assume free");
    const rail = typeof hit.chain === "string" ? hit.chain : typeof hit.network === "string" ? hit.network : "";
    fact(dl, "Network", RAILS[rail] || boundedText(rail, 120) || "Not supplied");
    fact(dl, "Request", boundedText(hit.method, 12) || "Method not listed");
    fact(dl, "Input schema listed", hasSchema(hit) ? "Yes; seller-supplied metadata" : "Not listed or unknown"); claims.appendChild(dl);
    const seen = el("section", "result-side"); seen.appendChild(el("h3", "result-side-label", "Previously observed"));
    const obs = observation(hit), time = observedTime(hit);
    if (!obs) seen.appendChild(el("p", "", "No prior 402Signal observation"));
    else {
      seen.appendChild(el("p", "", ageLabel(time)));
      const previous = el("dl", "checks compact");
      fact(previous, "Payment offer", obs.payable === true ? "Supported terms at that check" : obs.payable === false ? "Not established at that check" : "Unknown");
      fact(previous, "Invocation metadata", obs.invocable === true ? "Sufficient at that check" : obs.invocable === false ? "Insufficient at that check" : "Unknown");
      if (typeof obs.n_7d === "number" && Number.isSafeInteger(obs.n_7d) && obs.n_7d >= 0) fact(previous, "Observations in the last 7 days", obs.n_7d);
      if (typeof obs.last_latency_ms === "number" && Number.isFinite(obs.last_latency_ms) && obs.last_latency_ms >= 0) fact(previous, "Last HTTP probe time", obs.last_latency_ms + " ms; not settlement time");
      seen.appendChild(previous);
    }
    seen.appendChild(el("p", "policy-hint", "Historical evidence, not current availability, chain-account readiness or output quality."));
    sides.append(claims, seen); card.appendChild(sides);
    const details = el("details", "policy-advanced"); details.appendChild(el("summary", "", "Listing source and limitations"));
    details.appendChild(el("p", "", "Source: " + (boundedText(hit.source || (hit.claimed && hit.claimed.source), 180) || "Not provided in this response")));
    if (time != null) {
      const line = el("p", "mono wrap", "Observation timestamp: "), stamp = el("time", "", new Date(time).toISOString()); stamp.dateTime = new Date(time).toISOString(); line.appendChild(stamp); details.appendChild(line);
    }
    if (hit.facilitator) details.appendChild(el("p", "mono wrap", "Listed facilitator: " + boundedText(hit.facilitator, 500)));
    details.appendChild(el("p", "policy-hint", "Seller names, terms and schemas are untrusted catalog data. A current constrained check can return a different result. Capability matches do not guarantee interchangeable outputs.")); card.appendChild(details);
    const actions = el("div", "hero-actions"), choose = el("button", "btn", "Build check request");
    choose.type = "button"; choose.disabled = !httpsURL(hit.url); choose.addEventListener("click", () => selectEndpoint(hit));
    const copyURL = el("button", "copy-btn", "Copy endpoint"); copyURL.type = "button"; copyURL.disabled = !httpsURL(hit.url); copyURL.addEventListener("click", () => copy(hit.url, copyURL, "Copy endpoint")); actions.append(choose, copyURL);
    if (httpsURL(hit.url)) {
      const readiness = el('a', '', 'Inspect listed-endpoint readiness');
      readiness.href = '/developers?endpoint=' + encodeURIComponent(hit.url) + '#sellers'; actions.appendChild(readiness);
    }
    card.appendChild(actions); card.appendChild(el("p", "policy-hint", "Builds a request only. No purchase or wallet connection.")); return card;
  }
  function renderResults() {
    const results = $("search-results"); results.replaceChildren();
    const filter = $("display-filter").value;
    let hits = state.hits.filter(hit => filter === "all" || (filter === "observed" ? observation(hit) != null : hasSchema(hit)));
    const sort = $("display-sort").value;
    hits = hits.map((hit, index) => ({ hit, index })).sort((a, b) => {
      if (sort === "recent") return (observedTime(b.hit) || 0) - (observedTime(a.hit) || 0) || a.index - b.index;
      if (sort === "price") { const x = listedFixedPrice(a.hit), y = listedFixedPrice(b.hit); return x == null ? (y == null ? a.index - b.index : 1) : y == null ? -1 : x - y || a.index - b.index; }
      return a.index - b.index;
    }).map(row => row.hit);
    const observed = state.hits.filter(hit => observation(hit) != null).length;
    setText("catalog-summary", state.hits.length + " listings returned · " + observed + " with prior observations · " + hits.length + " shown");
    if (state.result && Number.isSafeInteger(state.result.discovery_matches) && state.result.discovery_matches > state.hits.length) results.appendChild(el("p", "policy-hint", state.result.discovery_matches + (state.result.discovery_exhaustive === true ? " discovery matches; this response is a subset." : " matches returned by discovery; coverage is not exhaustive.")));
    if (!hits.length) results.appendChild(el("p", "empty-state", state.hits.length ? "No returned listings meet this display filter. Change the filter; your spending rules have not changed." : "No catalog matches found. Try a broader capability."));
    for (const hit of hits) results.appendChild(renderHit(hit));
  }
  function invalidateSearch(message) {
    ++state.sequence; if (state.controller) state.controller.abort(); state.hits = []; state.result = null;
    $("search-results").replaceChildren(); $("result-controls").hidden = true; $("search-results").setAttribute("aria-busy", "false"); setText("search-status", message);
  }
  async function runSearch() {
    const query = $("need").value.trim(); if (!query || query.length > 300) return;
    const sequence = ++state.sequence; if (state.controller) state.controller.abort();
    const controller = new AbortController(); state.controller = controller;
    const timer = window.setTimeout(() => controller.abort(), 20000);
    const options = { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal };
    state.hits = []; state.result = null; $("search-results").replaceChildren(); $("result-controls").hidden = true;
    $("search-results").setAttribute("aria-busy", "true"); setText("search-status", "Searching catalog...");
    try {
      const response = await fetch(previewUrl(), options); if (sequence !== state.sequence) return;
      if (!response.ok) {
        let message = response.status === 429 ? "Too many searches. Wait before trying again; your filters are preserved." : response.status === 400 ? "The catalog could not accept this search. Check the capability and network." : response.status === 502 || response.status === 503 ? "Catalog data is unavailable or refreshing. No payment was made." : "Catalog request failed (HTTP " + response.status + "). No payment was made.";
        if (response.status === 502 || response.status === 503) {
          try {
            const pulseResponse = await fetch("/pulse", options); const pulse = pulseResponse.ok ? await readJSON(pulseResponse) : null;
            if (pulse && ["pending", "refreshing"].includes(pulse.index_status)) message = "Catalog data is refreshing. Try again shortly. No payment was made.";
          } catch (_) { /* Preserve the explicit unavailable result. */ }
        }
        throw new Error(message);
      }
      const parsed = await readJSON(response); if (sequence !== state.sequence) return;
      if (!Array.isArray(parsed.hits) || parsed.hits.length > 200) throw new Error("The catalog returned an unreadable response. No payment was made.");
      state.hits = parsed.hits.filter(hit => hit && typeof hit === "object" && !Array.isArray(hit)); state.result = parsed;
      $("result-controls").hidden = state.hits.length === 0; renderResults(); setText("search-status", "Catalog response received. Endpoints have not been rechecked.");
    } catch (error) {
      if (sequence !== state.sequence) return;
      const known = typeof error.message === "string" && /^(Too many searches|The catalog|Catalog request|Catalog data)/.test(error.message);
      setText("search-status", controller.signal.aborted ? "Search timed out. Try again; no payment was made." : known ? error.message : "Could not load the catalog. Check your connection and try again; no payment was made.");
    } finally { window.clearTimeout(timer); if (sequence === state.sequence) $("search-results").setAttribute("aria-busy", "false"); }
  }
  function group(id, attr, key, values) {
    $(id).addEventListener("click", event => {
      const button = event.target.closest("button[" + attr + "]"); if (!button || !$(id).contains(button)) return;
      const value = button.getAttribute(attr); if (!values.includes(value)) return; state[key] = value;
      for (const item of $(id).querySelectorAll("button")) { item.classList.toggle("active", item === button); item.setAttribute("aria-pressed", item === button ? "true" : "false"); }
      syncBuilder(); if (key === "network" || key === "prefer") invalidateSearch("Network selection changed. Search again to refresh listings.");
    });
  }
  group("network-chips", "data-network", "network", ["any", "base", "solana", "algorand"]);
  group("prefer-chips", "data-prefer", "prefer", ["any", "base", "solana", "algorand"]);
  group("objective-chips", "data-objective", "objective", ["best", "cheapest", "fastest", "most_reliable"]);
  group("depth-chips", "data-depth", "depth", ["standard", "thorough"]);
  $("search-form").addEventListener("submit", event => { event.preventDefault(); runSearch(); });
  $("need-chips").addEventListener("click", event => { const button = event.target.closest("button[data-need]"); if (button) { $("need").value = button.dataset.need; syncBuilder(); runSearch(); } });
  $("need").addEventListener("input", () => { invalidateSearch("Search terms changed. Submit to refresh listings."); syncBuilder(); });
  for (const id of ["endpoint-url", "require-invocable", "require-binding", ...numericFields.map(row => row[0])]) $(id).addEventListener("input", syncBuilder);
  for (const radio of document.querySelectorAll('input[name="target-mode"]')) radio.addEventListener("change", syncBuilder);
  for (const id of ["display-filter", "display-sort"]) $(id).addEventListener("change", renderResults);
  for (const [id, format, label] of [["copy-route-json", "json", "Copy JSON"], ["copy-route-curl", "curl", "Copy curl"]]) $(id).addEventListener("click", () => { const { body, valid } = buildRouteBody(); syncBuilder(); if (valid) copy(format === "json" ? JSON.stringify(body, null, 2) : routeCurl(body), $(id), label); });
  const query = new URLSearchParams(window.location.search), initialNeed = query.get("need");
  // A share link may prefill a capability, never policies or credentials.
  if (initialNeed && initialNeed.length <= 300) $("need").value = initialNeed;
  syncBuilder();
})();
