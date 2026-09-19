import test from "node:test";
import assert from "node:assert/strict";
import { Credential, Receipt, Challenge } from "mppx";
import {
  session as nativeSession,
  createMemorySessionStore,
} from "@solana/mpp/server";
import { verifyTypedData } from "viem";
import { voucherTypes, BATCH_SETTLEMENT_DOMAIN } from "@x402/evm";
import { BASE_BATCH } from "../internal/base-batch-observer.js";
import { setup, merchantChallenge, nativeOwner } from "./fixtures.mjs";
import { hash, clone } from "../src/policy.mjs";
import { createSessionTransport } from "../src/transport.mjs";
const { verifyVoucherForChannel } = await import(
  new URL("./server/session/voucher.js", import.meta.resolve("@solana/mpp"))
);
function receiver(s) {
  let cumulative = 0n,
    calls = 0,
    nativeMethod,
    nativeStore;
  const receipts = new Map();
  return {
    receipts,
    get nativeMethod() {
      return nativeMethod;
    },
    get calls() {
      return calls;
    },
    async send(packet) {
      calls++;
      assert.equal(
        packet.request.requestDigest,
        hash(
          (await import("../src/policy.mjs")).canonical({
            url: packet.request.url,
            method: packet.request.method,
            body: packet.request.body,
          }),
        ),
      );
      let headers;
      if (s.rail === "solana") {
        const c = Credential.deserialize(packet.authorization),
          v = c.payload.voucher;
        assert.equal(
          c.challenge.digest,
          "sha-256=" +
            Buffer.from(packet.request.bodySha256, "hex").toString("base64"),
        );
        const state = {
          authorizedSigner: nativeOwner.address,
          channelId: s.plan.open.channelId,
          cumulative,
          deposit: BigInt(s.plan.policy.depositAtomic),
          sealed: false,
          committedDeliveries: [],
          pendingDeliveries: [],
          nextDeliverySequence: 0n,
        };
        if (!nativeMethod) {
          nativeStore = createMemorySessionStore();
          await nativeStore.updateChannel(packet.channelId, () => state);
          nativeMethod = nativeSession({
            operator: s.plan.policy.operator,
            recipient: s.plan.policy.recipient,
            cap: state.deposit,
            currency: s.plan.open.mint,
            decimals: 6,
            network: "mainnet",
            programId: s.plan.challenge.request.programId,
            modes: ["push"],
            pricing: { perDelivery: 1000n },
            minVoucherDelta: 1000n,
            settlementWindowSeconds: 900n,
            store: nativeStore,
          });
        }
        const standardReceipt = await nativeMethod.verify({ credential: c });
        assert.equal(
          standardReceipt.reference,
          packet.channelId + ":" + packet.cumulativeAmount,
        );
        cumulative = BigInt(v.data.cumulativeAmount);
        assert.equal(
          (await nativeStore.getChannel(packet.channelId)).cumulative,
          cumulative,
        );
        headers = { "payment-receipt": Receipt.serialize(standardReceipt) };
      } else {
        const v = packet.payload.payload.voucher;
        assert(
          await verifyTypedData({
            address: s.owner.address,
            domain: {
              ...BATCH_SETTLEMENT_DOMAIN,
              chainId: 8453,
              verifyingContract: BASE_BATCH,
            },
            types: voucherTypes,
            primaryType: "Voucher",
            message: {
              channelId: packet.channelId,
              maxClaimableAmount: BigInt(packet.cumulativeAmount),
            },
            signature: v.signature,
          }),
        );
        cumulative = BigInt(packet.cumulativeAmount);
        headers = {
          "payment-response": Buffer.from(
            JSON.stringify({
              success: true,
              network: "eip155:8453",
              transaction: "",
              payer: s.owner.address,
              extra: {
                chargedAmount: "1000",
                channelState: {
                  channelId: packet.channelId,
                  chargedCumulativeAmount: packet.cumulativeAmount,
                },
              },
            }),
          ).toString("base64"),
        };
      }
      const response = {
        status: 200,
        url: packet.request.url,
        requestDigest: packet.request.requestDigest,
        authorizationDigest: hash(packet.authorization),
        bodyText: '{"result":"synthetic"}',
        headers,
      };
      receipts.set(hash(packet.authorization), response);
      return response;
    },
  };
}
const request = (s, i) => ({
  url: s.policy.request.url,
  method: s.policy.request.method,
  body: s.policy.request.method === "POST" ? '{"query":"item ' + i + '"}' : "",
});
const challenge = (s, r) =>
  s.rail === "solana" ? merchantChallenge(s.plan, r.body) : s.rawChallenge;
for (const rail of ["base", "solana"])
  for (const count of [3, 10, 64])
    test(
      rail +
        " " +
        count +
        " standard SDK calls over two hours and durable restart",
      async () => {
        const real = Date.now;
        let now = 1800000000000;
        Date.now = () => now;
        let s;
        try {
          s = await setup(rail, count, count === 10 ? "POST" : "GET");
          await s.funded();
          const recv = receiver(s);
          let controller = s.client,
            peer;
          for (let i = 1; i <= count; i++) {
            now += Math.floor(7200000 / count);
            if (i === Math.ceil(count / 2)) {
              peer = await s.reopen();
              controller = peer.client;
            }
            const r = request(s, i),
              result = await controller.deliver(
                s.owner,
                i,
                r,
                challenge(s, r),
                (packet) => recv.send(packet),
              );
            assert.equal(
              result.state,
              "voucher_accepted",
              JSON.stringify({ rail, i, result }),
            );
            assert.equal(result.chainSettled, false);
            assert.equal(result.authorizedCumulativeAtomic, String(i * 1000));
          }
          assert.equal(recv.calls, count);
          assert.equal(
            (await s.ledger.require("progress")).state,
            "active:" + count,
          );
          const original = await s.ledger.require("continuation:v2");
          assert(original.initialExpiresAt < now);
          assert.equal(original.identity.policy.expiresAt, 1800014400000);
          await assert.rejects(
            controller.deliver(
              s.owner,
              count + 1,
              request(s, count + 1),
              s.rawChallenge,
              () => assert.fail(),
            ),
          );
          if (rail === "base") await controller.close(count);
          else {
            const r = request(s, count),
              fresh = challenge(s, r);
            const closed = await controller.close(
              count,
              r,
              fresh,
              async (packet) => {
                assert.equal(
                  packet.payload.voucher.data.cumulativeAmount,
                  String(count * 1000),
                );
                const credential = Credential.deserialize(packet.authorization);
                assert.equal(
                  credential.challenge.id,
                  Challenge.deserialize(fresh).id,
                );
                const receipt = await recv.nativeMethod.verify({ credential });
                return {
                  status: 200,
                  url: r.url,
                  requestDigest: packet.request.requestDigest,
                  authorizationDigest: hash(packet.authorization),
                  bodyText: "{}",
                  headers: { "payment-receipt": Receipt.serialize(receipt) },
                };
              },
            );
            assert.equal(closed.state, "close_requested");
            assert.equal(closed.chainSettled, false);
            await assert.rejects(
              controller.close(count, r, fresh, () =>
                assert.fail("no close replay"),
              ),
            );
          }
          peer?.ledger.close();
        } finally {
          s?.ledger.close();
          Date.now = real;
        }
      },
    );
for (const rail of ["base", "solana"])
  test(
    rail +
      " lost ACK cannot sign/send again; exact read-only recovery works after expiry",
    async () => {
      const real = Date.now;
      let now = 1800000000000;
      Date.now = () => now;
      let s, peer;
      try {
        s = await setup(rail, 3);
        await s.funded();
        now += 900000;
        const recv = receiver(s),
          r = request(s, 1);
        let signs = 0;
        const method = rail === "base" ? "signTypedData" : "signMessages",
          owner = {
            ...s.owner,
            [method]: async (...args) => {
              signs++;
              return s.owner[method](...args);
            },
          };
        assert.equal(
          (
            await s.client.deliver(
              owner,
              1,
              r,
              challenge(s, r),
              async (packet) => {
                await recv.send(packet);
                throw Error("lost ACK");
              },
            )
          ).state,
          "unknown",
        );
        peer = await s.reopen();
        await assert.rejects(
          peer.client.deliver(owner, 2, request(s, 2), challenge(s, r), () =>
            assert.fail(),
          ),
        );
        now = s.policy.expiresAt + 1;
        assert.equal(
          (
            await peer.client.recoverDelivery(1, async (packet) => ({
              ...recv.receipts.get(packet.authorizationDigest),
              recoveryOnly: true,
            }))
          ).state,
          "voucher_accepted",
        );
        assert.equal(recv.calls, 1);
        assert.equal(signs, rail === "base" ? 0 : 1);
        await assert.rejects(
          peer.client.deliver(owner, 2, request(s, 2), challenge(s, r), () =>
            assert.fail(),
          ),
        );
      } finally {
        peer?.ledger.close();
        s?.ledger.close();
        Date.now = real;
      }
    },
  );
for (const rail of ["base", "solana"])
  test(
    rail +
      " two durable connections grant one delivery; malformed request and changed terms stay unsigned",
    async () => {
      const real = Date.now;
      let now = 1800000000000;
      Date.now = () => now;
      let s, peer;
      try {
        s = await setup(rail, 3, "POST");
        await s.funded();
        now += 900000;
        peer = await s.reopen();
        const recv = receiver(s),
          r = request(s, 1);
        for (const body of ['{"x":1,"x":2}', "x".repeat(4097)])
          await assert.rejects(
            s.client.deliver(s.owner, 1, { ...r, body }, challenge(s, r), () =>
              assert.fail(),
            ),
          );
        let bad = challenge(s, r);
        if (rail === "base") {
          const e = JSON.parse(bad);
          e.accepts[0].amount = "2000";
          bad = JSON.stringify(e);
        } else {
          const { Challenge } = await import("mppx");
          const e = Challenge.deserialize(bad);
          e.request.cap = "9999";
          bad = Challenge.serialize(e);
        }
        await assert.rejects(
          s.client.deliver(s.owner, 1, r, bad, () => assert.fail()),
        );
        const outcomes = await Promise.allSettled(
          [s.client, peer.client].map((c) =>
            c.deliver(s.owner, 1, r, challenge(s, r), (packet) =>
              recv.send(packet),
            ),
          ),
        );
        assert.equal(
          outcomes.filter(
            (x) =>
              x.status === "fulfilled" && x.value.state === "voucher_accepted",
          ).length,
          1,
        );
        assert.equal(recv.calls, 1);
      } finally {
        peer?.ledger.close();
        s?.ledger.close();
        Date.now = real;
      }
    },
  );
test("native challenge expiry during signing never sends and restart never signs again", async () => {
  const real = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  let s, peer;
  try {
    s = await setup("solana", 3);
    await s.funded();
    now += 900000;
    let signs = 0,
      sends = 0;
    const owner = {
      address: s.owner.address,
      signMessages: async (...a) => {
        signs++;
        const result = await s.owner.signMessages(...a);
        now += 61000;
        return result;
      },
    };
    const r = request(s, 1);
    assert.equal(
      (
        await s.client.deliver(owner, 1, r, challenge(s, r), async () => {
          sends++;
        })
      ).state,
      "unknown",
    );
    peer = await s.reopen();
    await assert.rejects(
      peer.client.deliver(owner, 1, r, challenge(s, r), () => assert.fail()),
    );
    assert.equal(signs, 1);
    assert.equal(sends, 0);
  } finally {
    peer?.ledger.close();
    s?.ledger.close();
    Date.now = real;
  }
});
test("transport preserves exact POST bytes, never retries and recovery receives no payment authority", async () => {
  const calls = [],
    packet = {
      request: {
        url: "https://merchant.example/session",
        method: "POST",
        body: '{ "q": "private" }',
        requestDigest: "a".repeat(64),
      },
      authorization: "Payment synthetic",
      rail: "solana",
    };
  let lookup = 0;
  const transport = createSessionTransport({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", {
        status: 200,
        headers: { "Payment-Receipt": "synthetic" },
      });
    },
    readReceipt: async (scope) => {
      lookup++;
      assert.equal(scope.authorization, undefined);
      assert.equal(scope.body, undefined);
      return { status: 503 };
    },
  });
  await transport.send(packet);
  assert.equal(calls[0].init.body, packet.request.body);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  await transport.recover({
    recoveryOnly: true,
    channelId: "synthetic",
    sequence: 1,
    requestDigest: packet.request.requestDigest,
    authorizationDigest: hash(packet.authorization),
  });
  assert.equal(lookup, 1);
  assert.equal(calls.length, 1);
  await assert.rejects(
    createSessionTransport({ fetch: () => assert.fail() }).recover({
      recoveryOnly: true,
      channelId: "synthetic",
      sequence: 1,
      requestDigest: packet.request.requestDigest,
      authorizationDigest: hash(packet.authorization),
    }),
  );
});
