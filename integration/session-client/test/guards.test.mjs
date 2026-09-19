import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setup, merchantChallenge } from "./fixtures.mjs";
import {
  LocalBatchLedger,
  LocalOperationJournal,
} from "../internal/local-ledger.mjs";
import { BaseSessionClient } from "../src/base.mjs";
import { SolanaSessionClient } from "../src/solana.mjs";
import { readInitialObservation, canonical, hash } from "../src/policy.mjs";
import { Receipt } from "mppx";
function construct(s, ledger, policy = s.policy, proof = s.proof) {
  return s.rail === "base"
    ? new BaseSessionClient(
        ledger,
        new LocalOperationJournal(ledger),
        s.client.rpc,
        s.plan,
        { policy, initialObservation: proof },
      )
    : new SolanaSessionClient(ledger, s.plan, {
        policy,
        initialObservation: proof,
      });
}
const snapshot = (s) => ({
  url: s.policy.request.url,
  method: "GET",
  body: "",
});
const challenge = (s) =>
  s.rail === "base" ? s.rawChallenge : merchantChallenge(s.plan);
function reply(packet) {
  return {
    status: 200,
    url: packet.request.url,
    requestDigest: packet.request.requestDigest,
    authorizationDigest: hash(packet.authorization),
    bodyText: "{}",
    headers:
      packet.rail === "base"
        ? {
            "payment-response": Buffer.from(
              JSON.stringify({
                success: true,
                network: "eip155:8453",
                transaction: "",
                extra: {
                  chargedAmount: "1000",
                  channelState: {
                    channelId: packet.channelId,
                    chargedCumulativeAmount: packet.cumulativeAmount,
                  },
                },
              }),
            ).toString("base64"),
          }
        : {
            "payment-receipt": Receipt.serialize(
              Receipt.from({
                method: "solana",
                status: "success",
                reference: packet.channelId + ":" + packet.cumulativeAmount,
                timestamp: new Date().toISOString(),
              }),
            ),
          },
  };
}
for (const rail of ["base", "solana"])
  test(
    rail +
      " proof, unit economics, policy expansion and old campaign adoption fail before funding",
    async () => {
      const real = Date.now;
      Date.now = () => 1800000000000;
      let s;
      const ledgers = [];
      try {
        s = await setup(rail, 3);
        for (const mutate of [
          (p) => (p.maxCalls = 65),
          (p) => (p.maxCumulativeAtomic = "5000"),
          (p) => (p.expiresAt += 86400000),
          (p) => (p.request.url = "https://other.example/session"),
        ]) {
          const policy = structuredClone(s.policy);
          mutate(policy);
          await assert.rejects(construct(s, s.ledger, policy).initialize());
        }
        const directory = mkdtempSync(join(tmpdir(), "proof-refusal-"));
        chmodSync(directory, 0o700);
        const ledger = new LocalBatchLedger(directory, "reject-proof-" + rail);
        ledgers.push(ledger);
        const proof = structuredClone(s.proof),
          response = JSON.parse(proof.routeResponseJson);
        response.live = false;
        proof.routeResponseJson = JSON.stringify(response);
        await assert.rejects(
          construct(s, ledger, s.policy, proof).initialize(),
        );
        assert.equal(await ledger.get("continuation:v2"), undefined);
        assert.equal(await ledger.get("open:sign-intent"), undefined);
        assert.equal(await ledger.get("deposit:typed:1"), undefined);
        await s.funded();
        const legacyDir = mkdtempSync(join(tmpdir(), "legacy-refusal-"));
        chmodSync(legacyDir, 0o700);
        const legacy = new LocalBatchLedger(
          legacyDir,
          "legacy-refusal-" + rail,
        );
        ledgers.push(legacy);
        await legacy.bind(await s.ledger.require("plan"));
        await legacy.once("progress", { state: "active:0" });
        if (rail === "base") await legacy.once("baseline", {});
        await assert.rejects(construct(s, legacy).initialize(), /cannot adopt/);
      } finally {
        for (const l of ledgers) l.close();
        s?.ledger.close();
        Date.now = real;
      }
    },
  );
for (const rail of ["base", "solana"])
  test(
    rail +
      " accepted-write lost acknowledgment repairs state without any new callback",
    async () => {
      const real = Date.now;
      let now = 1800000000000;
      Date.now = () => now;
      let s, peer;
      try {
        s = await setup(rail, 3);
        await s.funded();
        now += 120000;
        const once = s.ledger.once.bind(s.ledger),
          stage = (rail === "base" ? "delivery:" : "voucher:") + "1:accepted";
        let fired = false;
        s.ledger.once = async (k, v) => {
          const result = await once(k, v);
          if (k === stage && !fired) {
            fired = true;
            throw Error("lost database ACK");
          }
          return result;
        };
        assert.equal(
          (
            await s.client.deliver(
              s.owner,
              1,
              snapshot(s),
              challenge(s),
              async (packet) => reply(packet),
            )
          ).state,
          "unknown",
        );
        peer = await s.reopen();
        assert.equal(
          (
            await peer.client.recoverDelivery(1, () =>
              assert.fail("receipt already durable"),
            )
          ).state,
          "voucher_accepted",
        );
        assert.equal((await peer.ledger.require("progress")).state, "active:1");
      } finally {
        peer?.ledger.close();
        s?.ledger.close();
        Date.now = real;
      }
    },
  );
for (const rail of ["base", "solana"])
  test(
    rail + " stale receipt or altered authority cannot clear an ambiguous call",
    async () => {
      const real = Date.now;
      let now = 1800000000000;
      Date.now = () => now;
      let s;
      try {
        s = await setup(rail, 3);
        await s.funded();
        now += 120000;
        let saved;
        assert.equal(
          (
            await s.client.deliver(
              s.owner,
              1,
              snapshot(s),
              challenge(s),
              async (packet) => {
                saved = reply(packet);
                throw Error("lost");
              },
            )
          ).state,
          "unknown",
        );
        assert.equal(
          (
            await s.client.recoverDelivery(1, async () => ({
              ...saved,
              authorizationDigest: "0".repeat(64),
              recoveryOnly: true,
            }))
          ).state,
          "unknown",
        );
        const bad = structuredClone(saved);
        if (rail === "base") {
          const h = JSON.parse(
            Buffer.from(bad.headers["payment-response"], "base64"),
          );
          h.extra.channelState.chargedCumulativeAmount = "2000";
          bad.headers["payment-response"] = Buffer.from(
            JSON.stringify(h),
          ).toString("base64");
        } else
          bad.headers["payment-receipt"] = Receipt.serialize(
            Receipt.from({
              method: "solana",
              status: "success",
              reference: s.plan.open.channelId + ":2000",
              timestamp: new Date().toISOString(),
            }),
          );
        assert.equal(
          (
            await s.client.recoverDelivery(1, async () => ({
              ...bad,
              recoveryOnly: true,
            }))
          ).state,
          "unknown",
        );
        assert.equal(
          (
            await s.client.recoverDelivery(1, async () => ({
              ...saved,
              recoveryOnly: true,
            }))
          ).state,
          "voucher_accepted",
        );
      } finally {
        s?.ledger.close();
        Date.now = real;
      }
    },
  );
for (const rail of ["base", "solana"])
  test(
    rail +
      " fresh process resumes from complete private initial proof after observation expiry",
    async () => {
      const real = Date.now;
      Date.now = () => 1800000000000;
      let s;
      try {
        s = await setup(rail, 3);
        await s.funded();
        assert.equal(
          canonical(await readInitialObservation(s.ledger)),
          canonical(s.proof),
        );
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
   import {LocalBatchLedger,LocalOperationJournal} from './internal/local-ledger.mjs';
   import {BaseSessionClient} from './src/base.mjs';import {SolanaSessionClient} from './src/solana.mjs';
   import {baseOwner,nativeOwner,merchantChallenge} from './test/fixtures.mjs';
   import {hash} from './src/policy.mjs';import {Receipt} from 'mppx';
   Date.now=()=>1800003600000;
   const [directory,id,rail]=process.argv.slice(1),ledger=new LocalBatchLedger(directory,id),plan=await ledger.require('plan'),policy=(await ledger.require('continuation:v2')).identity.policy;
   const client=rail==='base'?new BaseSessionClient(ledger,new LocalOperationJournal(ledger),()=>{throw Error('no new funding RPC')},plan,{policy}):new SolanaSessionClient(ledger,plan,{policy});
   await client.initialize();const r={url:policy.request.url,method:'GET',body:''};const initial=client.continuation.binding.challenge;
   const challenge=rail==='base'?initial.bodyText:merchantChallenge(plan);
   const result=await client.deliver(rail==='base'?baseOwner:nativeOwner,1,r,challenge,async packet=>({status:200,url:r.url,requestDigest:packet.request.requestDigest,authorizationDigest:hash(packet.authorization),bodyText:'{}',headers:rail==='base'?{'payment-response':Buffer.from(JSON.stringify({success:true,network:'eip155:8453',transaction:'',extra:{chargedAmount:'1000',channelState:{channelId:packet.channelId,chargedCumulativeAmount:packet.cumulativeAmount}}})).toString('base64')}:{'payment-receipt':Receipt.serialize(Receipt.from({method:'solana',status:'success',reference:packet.channelId+':'+packet.cumulativeAmount,timestamp:new Date().toISOString()}))}}));
   console.log(JSON.stringify(result));ledger.close();if(result.state!=='voucher_accepted')process.exitCode=1;
  `,
            s.directory,
            s.id,
            rail,
          ],
          {
            cwd: new URL("..", import.meta.url),
            encoding: "utf8",
            timeout: 30000,
          },
        );
        assert.equal(child.status, 0, child.stdout + child.stderr);
        assert.equal(JSON.parse(child.stdout.trim()).state, "voucher_accepted");
        assert.equal((await s.ledger.require("progress")).state, "active:1");
      } finally {
        s?.ledger.close();
        Date.now = real;
      }
    },
  );

test("Base policy expiry during a new voucher signature fences transport and authority", async () => {
  const real = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  let s;
  try {
    s = await setup("base", 3);
    await s.funded();
    now += 120000;
    assert.equal(
      (
        await s.client.deliver(
          s.owner,
          1,
          snapshot(s),
          challenge(s),
          async (packet) => reply(packet),
        )
      ).state,
      "voucher_accepted",
    );
    let signs = 0,
      sends = 0;
    const owner = {
      address: s.owner.address,
      signTypedData: async (d) => {
        signs++;
        const sig = await s.owner.signTypedData(d);
        now = s.policy.expiresAt;
        return sig;
      },
    };
    assert.equal(
      (
        await s.client.deliver(
          owner,
          2,
          snapshot(s),
          challenge(s),
          async () => {
            sends++;
          },
        )
      ).state,
      "unknown",
    );
    assert.equal(signs, 1);
    assert.equal(sends, 0);
    await assert.rejects(
      s.client.deliver(owner, 2, snapshot(s), challenge(s), async () => {
        sends++;
      }),
    );
    assert.equal(signs, 1);
    assert.equal(sends, 0);
  } finally {
    s?.ledger.close();
    Date.now = real;
  }
});
test("native changed price, expired challenge and wrong POST digest never reach a signer", async () => {
  const { Challenge, BodyDigest } = await import("mppx");
  const real = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  let s;
  try {
    s = await setup("solana", 10, "POST");
    await s.funded();
    now += 120000;
    let signs = 0;
    const owner = {
        address: s.owner.address,
        signMessages: async () => {
          signs++;
          throw Error("must remain unsigned");
        },
      },
      request = {
        url: s.policy.request.url,
        method: "POST",
        body: '{"query":"private"}',
      };
    for (const mutate of [
      (c) => (c.expires = new Date(now - 1).toISOString()),
      (c) => (c.digest = BodyDigest.compute("different")),
      (c) => (c.request.minVoucherDelta = "2000"),
    ]) {
      const c = Challenge.deserialize(merchantChallenge(s.plan, request.body));
      mutate(c);
      await assert.rejects(
        s.client.deliver(owner, 1, request, Challenge.serialize(c), () =>
          assert.fail("must remain unsent"),
        ),
      );
    }
    assert.equal(signs, 0);
    assert.equal((await s.ledger.require("progress")).state, "active:0");
  } finally {
    s?.ledger.close();
    Date.now = real;
  }
});

for (const rail of ["base", "solana"])
  test(
    rail +
      " expired initial observation cannot authorize new funding under the longer policy",
    async () => {
      const real = Date.now;
      let now = 1800000000000;
      Date.now = () => now;
      let s,
        signs = 0,
        rpcs = 0;
      try {
        s = await setup(rail, 3);
        now += 61000;
        if (rail === "base")
          await assert.rejects(
            s.client.prepareDeposit({
              address: s.owner.address,
              signTypedData: async () => {
                signs++;
              },
            }),
          );
        else
          await assert.rejects(
            s.client.signOpen(
              {
                address: s.owner.address,
                signMessages: async () => {
                  signs++;
                },
              },
              async () => {
                rpcs++;
              },
            ),
          );
        assert.equal(signs, 0);
        assert.equal(rpcs, 0);
        assert.equal((await s.ledger.require("progress")).state, "new");
      } finally {
        s?.ledger.close();
        Date.now = real;
      }
    },
  );
