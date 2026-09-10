import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const wrapSrc = join(root, "scripts/exact_authorize.mjs");
const fixture = JSON.parse(
  readFileSync(join(root, "sdk/route-guard/test/support/search-example-fixture.json"), "utf8"),
);

class MemoryStore {
  #m = new Map();
  async get(id, part) {
    const key = id + ":" + part;
    return this.#m.has(key) ? structuredClone(this.#m.get(key)) : undefined;
  }
  async putOnce(id, part, value) {
    const key = id + ":" + part;
    if (this.#m.has(key)) return false;
    this.#m.set(key, structuredClone(value));
    return true;
  }
}

function linkGuard(dest) {
  mkdirSync(join(dest, "node_modules/@402signal"), { recursive: true });
  symlinkSync(join(root, "sdk/route-guard"), join(dest, "node_modules/@402signal/route-guard"));
  cpSync(wrapSrc, join(dest, "exact-authorize.mjs"));
}

async function loadWrap(dest) {
  return await import(pathToFileURL(join(dest, "exact-authorize.mjs")).href);
}

function missBody() {
  return {
    live: false,
    payable: false,
    invocable: false,
    selected_payment: null,
    miss_reason: "constraints_unmet",
    route_outcome: { version: 1, code: "free_miss", next_action: "change_constraints" },
    billing: {
      model: "success_only_v1",
      condition: "live_eligible_route_found",
      asset: "USDC",
      amount_atomic: "3000",
      display_amount: "$0.003",
      rail: "base",
      settlement_attempted: false,
      settled: false,
      settlement_state: "not_attempted",
    },
  };
}

async function withClient(dest, routerFetch, run) {
  const { RouteClient } = await import(
    pathToFileURL(join(dest, "node_modules/@402signal/route-guard/client.mjs")).href
  );
  const store = new MemoryStore();
  const client = new RouteClient({
    store,
    routerUrl: "https://402signal.example/route",
    recoveryProfile: "http-route-v1",
    fetch: routerFetch,
    now: () => fixture.now * 1000,
    timeoutMs: 5000,
  });
  return run({ client, store });
}

test("parseExactAuthorizeRequest refuses chk_grp and unbound requests", async () => {
  const dest = mkdtempSync(join(tmpdir(), "exact-auth-parse-"));
  try {
    linkGuard(dest);
    const { parseExactAuthorizeRequest } = await loadWrap(dest);
    assert.equal(
      parseExactAuthorizeRequest(JSON.stringify(fixture.request)).url,
      fixture.request.url,
    );
    assert.throws(() => parseExactAuthorizeRequest(JSON.stringify({ url: fixture.request.url })), e => e.code === "require_route_binding");
    assert.throws(
      () => parseExactAuthorizeRequest(JSON.stringify({ ...fixture.request, buyer_limits: {} })),
      e => e.code === "exact_path_only",
    );
    assert.throws(
      () => parseExactAuthorizeRequest(JSON.stringify({ need: "web search", require_route_binding: true })),
      e => e.code === "exact_url_required",
    );
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("wrapExactAuthorize teaches a constraint miss and does not call the seller signer", async () => {
  const dest = mkdtempSync(join(tmpdir(), "exact-auth-miss-"));
  try {
    linkGuard(dest);
    const { wrapExactAuthorize } = await loadWrap(dest);
    let seller = 0;
    let routing = 0;
    const body = missBody();
    await withClient(dest, async (url, init) => {
      assert.equal(url, "https://402signal.example/route");
      if (init.body === "{}" && init.headers["Replay-Only"] === "1") {
        return new Response(JSON.stringify({ error: "recovery_unavailable", recovery_only: true, new_payment_allowed: false }), { status: 503 });
      }
      if (!init.headers["PAYMENT-SIGNATURE"]) {
        return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "USDC", payTo: "0x22", amount: "3000" }] }), { status: 402 });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }, async ({ client }) => {
      const out = await wrapExactAuthorize({
        id: "job-one",
        requestJson: JSON.stringify(fixture.request),
        client,
        trustedLogVkey: fixture.trusted_vkey,
        signRouting: async () => {
          routing += 1;
          return "synthetic-routing-authorization-no-signature";
        },
        signSeller: async () => {
          seller += 1;
          return "should-not-run";
        },
      });
      assert.equal(out.state, "miss");
      assert.equal(out.keep_calling_route, true);
      assert.equal(out.miss_reason, "constraints_unmet");
      assert.equal(out.next_action, "change_constraints");
      assert.match(out.note, /not a broken router/);
      assert.equal(routing, 1);
      assert.equal(seller, 0);
    });
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("binding_unavailable is policy working and keeps /route available", async () => {
  const dest = mkdtempSync(join(tmpdir(), "exact-auth-bind-"));
  try {
    linkGuard(dest);
    const { wrapExactAuthorize } = await loadWrap(dest);
    let seller = 0;
    const body = {
      live: false,
      payable: false,
      selected_payment: null,
      binding_error: "route_binding_unavailable",
      binding_error_reason: "unsupported_challenge",
      route_outcome: { version: 1, code: "binding_failed", next_action: "fix_request_or_compatibility" },
      billing: {
        model: "success_only_v1",
        condition: "live_eligible_route_found",
        asset: "USDC",
        amount_atomic: "3000",
        display_amount: "$0.003",
        rail: "base",
        settlement_attempted: false,
        settled: false,
        settlement_state: "not_attempted",
      },
    };
    await withClient(dest, async (_url, init) => {
      if (init.body === "{}" && init.headers["Replay-Only"] === "1") {
        return new Response(JSON.stringify({ error: "recovery_unavailable", recovery_only: true, new_payment_allowed: false }), { status: 503 });
      }
      if (!init.headers["PAYMENT-SIGNATURE"]) {
        return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "USDC", payTo: "0x22", amount: "3000" }] }), { status: 402 });
      }
      return new Response(JSON.stringify(body), { status: 503 });
    }, async ({ client }) => {
      const out = await wrapExactAuthorize({
        id: "job-bind",
        requestJson: JSON.stringify(fixture.request),
        client,
        trustedLogVkey: fixture.trusted_vkey,
        signRouting: async () => "synthetic-routing-authorization-no-signature",
        signSeller: async () => {
          seller += 1;
        },
      });
      assert.equal(out.state, "binding_unavailable");
      assert.equal(out.keep_calling_route, true);
      assert.equal(out.next_action, "fix_request_or_compatibility");
      assert.equal(seller, 0);
    });
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("same wrap authorizes only after local verify, then again on the next spend", async () => {
  const dest = mkdtempSync(join(tmpdir(), "exact-auth-ok-"));
  const oldNow = Date.now;
  Date.now = () => fixture.now * 1000;
  try {
    linkGuard(dest);
    const { wrapExactAuthorize } = await loadWrap(dest);
    let jobs = 0;
    const runOnce = (id) => withClient(dest, async (_url, init) => {
      if (init.body === "{}" && init.headers["Replay-Only"] === "1") {
        return new Response(JSON.stringify({ error: "recovery_unavailable", recovery_only: true, new_payment_allowed: false }), { status: 503 });
      }
      if (!init.headers["PAYMENT-SIGNATURE"]) {
        return new Response(JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: "eip155:8453", asset: fixture.challenge.accepts[0].asset, payTo: "0x" + "22".repeat(20), amount: "3000" }],
        }), { status: 402 });
      }
      return new Response(JSON.stringify(fixture.response), {
        status: 200,
        headers: { "PAYMENT-RESPONSE": "synthetic-router-receipt" },
      });
    }, async ({ client }) => {
      let seller = 0;
      const out = await wrapExactAuthorize({
        id,
        requestJson: JSON.stringify(fixture.request),
        client,
        trustedLogVkey: fixture.trusted_vkey,
        signRouting: async () => "synthetic-routing-authorization-no-signature",
        confirmRouting: async () => true,
        fetchSellerChallenge: async (request) => {
          assert.equal(request.url, fixture.request.url);
          const body = JSON.stringify(fixture.challenge);
          return {
            status: 402,
            bodyText: body,
            paymentRequired: Buffer.from(body).toString("base64"),
          };
        },
        signSeller: async (verified) => {
          seller += 1;
          assert.equal(verified.request.url, fixture.request.url);
          return { ok: true, job: id };
        },
      });
      assert.equal(out.state, "authorized");
      assert.equal(out.keep_calling_route, true);
      assert.equal(seller, 1);
      assert.equal(out.sellerResult.ok, true);
      jobs += 1;
    });
    await runOnce("spend-a");
    await runOnce("spend-b");
    assert.equal(jobs, 2);
  } finally {
    Date.now = oldNow;
    rmSync(dest, { recursive: true, force: true });
  }
});

test("installer copies the wrap next to the published package", (t) => {
  const packDir = process.env.PACK_DIR;
  if (!packDir) {
    t.skip("PACK_DIR not set");
    return;
  }
  const dest = mkdtempSync(join(tmpdir(), "exact-auth-install-"));
  try {
    const result = spawnSync(process.execPath, [
      join(root, "scripts/install_route_guard.mjs"),
      "--destination", dest,
      "--archive", join(packDir, "402signal-route-guard-0.7.2.tgz"),
      "--checksum-file", join(packDir, "SHA256SUMS"),
      "--capabilities", join(root, "live402/static/capabilities.json"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.wrap, "exact-authorize.mjs");
    assert.match(readFileSync(join(dest, "exact-authorize.mjs"), "utf8"), /wrapExactAuthorize/);
    assert.match(readFileSync(join(dest, "exact-authorize.d.ts"), "utf8"), /wrapExactAuthorize/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
