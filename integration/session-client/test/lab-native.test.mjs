import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Challenge } from "mppx";
import { serializeSessionCredential } from "@solana/mpp/client";
import { createNativeContinuationMerchant } from "../../lab/solana-session-contracts/src/merchant-session-v2.mjs";
import {
  args,
  payer,
  operator,
  rpcFixture,
} from "../../lab/solana-session-contracts/test/campaign-cli-support.mjs";
import { SolanaSessionClient } from "../src/solana.mjs";
import { LocalBatchLedger } from "../internal/local-ledger.mjs";
import { createSessionTransport } from "../src/transport.mjs";
import { signedObservation } from "./fixtures.mjs";
import { validateSolanaSessionProfile } from "../route-guard/batch-profiles/solana.mjs";
test("native v2 actual SDK opening, HTTP3calls over hours, restart/lookup and finalized close/refund after policy expiry", async () => {
  const real = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  const dir = mkdtempSync(join(tmpdir(), "native-v2-full-")),
    ledger = new LocalBatchLedger(join(dir, "merchant"), "native-v2"),
    ownerLedger = new LocalBatchLedger(join(dir, "buyer"), "buyer-v2");
  let server, peer, chain, merchant;
  try {
    const input = args(),
      url = "https://merchant.example/solana/session/sha256",
      expiresAt = now + 4 * 3600000;
    input.policy.voucherExpiresAt = Math.floor(now / 1000) + 8 * 3600;
    let readonly = 0,
      opens = 0,
      closes = 0;
    const rpc = async (method, params) => {
      readonly++;
      if (method === "getLatestBlockhash")
        return {
          context: { slot: 444444 + Math.floor((now - 1800000000000) / 400) },
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 999999,
          },
        };
      return chain.rpc(method, params);
    };
    const options = {
      rpc,
      url,
      policy: input.policy,
      perCallAtomic: "1000",
      maxCalls: 3,
      expiresAt,
      migrateSchema: true,
    };
    merchant = await createNativeContinuationMerchant({ ...options, ledger });
    const first = await merchant.request(url),
      again = await merchant.request(url);
    assert.equal(first.status, 402);
    assert.equal(
      first.headers["WWW-Authenticate"],
      again.headers["WWW-Authenticate"],
    );
    const plan = merchant.plan,
      initialRaw = plan.rawChallenge;
    chain = rpcFixture(plan);
    const limits = {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: plan.open.mint,
      recipient: operator.address,
      operator: operator.address,
      program_id: plan.challenge.request.programId,
      max_session_cap_atomic: "4000",
    };
    const initialObservation = signedObservation(
      "solana-mpp-session-v1",
      url,
      {
        status: 402,
        bodyText: "",
        paymentRequired: null,
        wwwAuthenticate: initialRaw,
      },
      limits,
      validateSolanaSessionProfile(plan.challenge.request, { url }, limits),
    );
    const policy = {
        version: 2,
        maxCalls: 3,
        perCallAtomic: "1000",
        maxCumulativeAtomic: "3000",
        expiresAt,
        request: { url, method: "GET", maxBodyBytes: 0 },
      },
      client = new SolanaSessionClient(ownerLedger, plan, {
        policy,
        initialObservation,
      });
    await client.initialize();
    await client.signOpen(payer, rpc);
    let full;
    assert.equal(
      (
        await client.sendOpen(async (credential) => {
          opens++;
          const reference = await chain.opened(credential),
            tx = await chain.rpc("getTransaction", [reference]);
          full = {
            ...credential.payload,
            signature: reference,
            transaction: tx.transaction[0],
          };
          return { reference };
        })
      ).state,
      "provider_ack",
    );
    assert.equal((await client.confirmOpen(rpc)).state, "chain_confirmed");
    now += 900000;
    assert(now > plan.expiresAt);
    const registration = serializeSessionCredential({
      challenge: plan.challenge,
      payload: full,
    });
    assert.equal((await merchant.request(url, registration)).status, 200);
    server = createServer(async (req, res) => {
      const response = await merchant.request(url, req.headers.authorization);
      res.writeHead(response.status, response.headers);
      res.end(response.bodyText);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const target = "http://127.0.0.1:" + server.address().port;
    const transport = createSessionTransport({
        fetch: async (_, init) => {
          const r = await fetch(target, init);
          return new Response(r.body, { status: r.status, headers: r.headers });
        },
        readReceipt: (scope) => merchant.lookupReceipt(scope),
      }),
      request = { url, method: "GET", body: "" };
    const once = ledger.once.bind(ledger);
    let lostWrite = false;
    ledger.once = async (key, value) => {
      const result = await once(key, value);
      if (key === "merchant:voucher:1:response" && !lostWrite) {
        lostWrite = true;
        throw Error("lost merchant DB ACK");
      }
      return result;
    };
    for (let n = 1; n <= 3; n++) {
      now = 1800000000000 + n * 2400000;
      const unsigned = await fetch(target),
        current = unsigned.headers.get("www-authenticate");
      assert.equal(unsigned.status, 402);
      assert.notEqual(current, initialRaw);
      assert.equal(
        (await fetch(target)).headers.get("www-authenticate"),
        current,
      );
      const result = await client.deliver(
        payer,
        n,
        request,
        current,
        async (packet) => {
          const response = await transport.send(packet);
          if (n === 2) throw Error("lost HTTP ACK");
          return response;
        },
      );
      if (n <= 2) {
        assert.equal(result.state, "unknown");
        const before = readonly;
        assert.equal(
          (await client.recoverDelivery(n, transport.recover)).state,
          "voucher_accepted",
        );
        assert.equal(readonly, before);
      } else assert.equal(result.state, "voucher_accepted");
      if (n === 1) {
        peer = new LocalBatchLedger(join(dir, "merchant"), "native-v2");
        merchant = await createNativeContinuationMerchant({
          ...options,
          ledger: peer,
        });
        assert.equal(
          (await merchant.request(url)).headers["WWW-Authenticate"],
          current,
        );
      }
    }
    assert.equal((await ownerLedger.require("progress")).state, "active:3");
    assert.equal((await ledger.require("progress")).state, "active:3");
    now = expiresAt + 60000;
    merchant = await createNativeContinuationMerchant({
      ...options,
      ledger: peer,
    });
    await assert.rejects(
      client.deliver(payer, 4, request, initialRaw, () => assert.fail()),
    );
    const closeChallenge = (await fetch(target)).headers.get(
      "www-authenticate",
    );
    assert.equal(
      (await client.close(3, request, closeChallenge, transport.send)).state,
      "close_requested",
    );
    const credential = await ownerLedger.require("close:credential");
    closes++;
    const signature = await chain.closed(credential);
    const final = await client.confirmClose(rpc, signature);
    assert.equal(final.state, "chain_confirmed");
    assert.equal(final.merchantAtomic, "3000");
    assert.equal(final.returnedBuyerAtomic, "1000");
    assert.equal((await ownerLedger.require("progress")).state, "closed");
    assert.equal(opens, 1);
    assert.equal(closes, 1);
    assert.equal(merchant.plan.rawChallenge, initialRaw);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    peer?.close();
    ledger.close();
    ownerLedger.close();
    Date.now = real;
  }
});

test("native v2 factory refuses invalid scope before writes and defaults to read-only schema readiness", async () => {
  const real = Date.now;
  Date.now = () => 1800000000000;
  const input = args(),
    calls = [];
  try {
    const options = {
      url: "https://merchant.example/solana/session/sha256",
      policy: input.policy,
      perCallAtomic: "1000",
      maxCalls: 3,
      expiresAt: Date.now() + 600000,
      rpc: async () => calls.push("rpc"),
      ledger: {
        initialize: async () => calls.push("DDL"),
        assertReady: async () => {
          calls.push("ready");
          throw Error("schema unavailable");
        },
        bind: async () => calls.push("write"),
      },
    };
    for (const changed of [
      { maxCalls: 2 },
      { maxCalls: 65 },
      { perCallAtomic: "0" },
      { expiresAt: Date.now() + 86400001 },
    ])
      await assert.rejects(
        createNativeContinuationMerchant({ ...options, ...changed }),
      );
    assert.deepEqual(calls, []);
    await assert.rejects(
      createNativeContinuationMerchant(options),
      /schema unavailable/,
    );
    assert.deepEqual(calls, ["ready"]);
  } finally {
    Date.now = real;
  }
});
