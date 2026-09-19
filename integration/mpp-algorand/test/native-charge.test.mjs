import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
  createHash,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address } from "@algorandfoundation/algokit-utils";
import {
  decodeTransaction,
  encodeTransactionRaw,
  encodeSignedTransaction,
  decodeSignedTransaction,
  bytesForSigning,
  transactionCodec,
} from "@algorandfoundation/algokit-utils/transact";
import { algorand as serverAlgorand } from "@goplausible/algorand-mpp-sdk/server";
import { Challenge, Credential, Receipt } from "mppx";
import {
  prepareNativeAlgorandCharge,
  executeNativeAlgorandCharge,
  confirmNativeAlgorandCharge,
  checkNativeAlgorandCurrentParams,
} from "../index.mjs";
import { AlgorandManifestStore } from "../../batch-buyer/algorand/manifest-store.mjs";
const NOW = 1800000000,
  NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  GENESIS = NETWORK.slice(9);
process.env.LIVE402_FIXTURE = "1";
function key() {
  const p = generateKeyPairSync("ed25519");
  return {
    ...p,
    address: new Address(
      p.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    ).toString(),
  };
}
const buyer = key(),
  merchant = key(),
  sponsor = key();
const current = {
  fee: 0,
  "min-fee": 1000,
  "last-round": 1000,
  "genesis-hash": GENESIS,
  "genesis-id": "mainnet-v1.0",
};
function signature(txn, k = buyer) {
  return encodeSignedTransaction({
    txn,
    sig: nodeSign(null, bytesForSigning.transaction(txn), k.privateKey),
  });
}
async function actualOffer(sponsored = false, changes = {}) {
  const original = globalThis.fetch;
  let reads = 0;
  const server = serverAlgorand.charge({
    recipient: merchant.address,
    network: NETWORK,
    asaId: 31566704n,
    algodUrl: "https://synthetic-rpc.example",
    ...(sponsored
      ? {
          signerAddress: sponsor.address,
          signer: async (tx, indexes) =>
            indexes.map((i) => signature(tx[i], sponsor)),
        }
      : {}),
  });
  try {
    globalThis.fetch = async (url, options) => {
      reads++;
      assert.equal(url, "https://synthetic-rpc.example/v2/transactions/params");
      assert.equal(options, undefined);
      return Response.json({ ...current, ...changes });
    };
    const request = await server.request({
      credential: undefined,
      request: {
        amount: "1000",
        currency: "USDC",
        recipient: "",
        methodDetails: { challengeReference: "", lease: "" },
        externalId: "order-1",
      },
    });
    assert.equal(reads, 1);
    return { server, request };
  } finally {
    globalThis.fetch = original;
  }
}
function prepare(offer, sponsored = false, adjust = {}) {
  const limits = {
    network: NETWORK,
    asset: "31566704",
    recipient: merchant.address,
    realm: "payments.example",
    max_amount_atomic: "1000",
    max_network_fee_micro_algo: "20000",
    fee_payer: sponsored ? sponsor.address : null,
  };
  const challenge = {
    status: 402,
    bodyText: "",
    paymentRequired: null,
    wwwAuthenticate: Challenge.serialize({
      id: "challenge-1",
      realm: "payments.example",
      method: "algorand",
      intent: "charge",
      expires: new Date((NOW + 60) * 1000).toISOString(),
      request: offer,
    }),
  };
  return prepareNativeAlgorandCharge({
    request: {
      url: "https://merchant.example/paid?x=%61&n=1",
      method: "GET",
      body: new Uint8Array(),
    },
    challenge,
    limits,
    buyer: buyer.address,
    now: NOW,
    ...adjust,
  });
}
const sign = async (raw, indexes) =>
  raw.map((b, i) =>
    indexes.includes(i) ? signature(decodeTransaction(b)) : null,
  );
const keyFor = (id, stage) =>
  createHash("sha256")
    .update(JSON.stringify(["native-algorand-charge-v1", id, stage]))
    .digest("hex");
for (const sponsored of [false, true])
  test(`actual GoPlausible SDK native charge ${sponsored ? "sponsored" : "buyer-paid"} signs once and server broadcasts once`, async () => {
    const { server, request } = await actualOffer(sponsored),
      plan = prepare(request, sponsored),
      store = new AlgorandManifestStore(":memory:"),
      originalFetch = globalThis.fetch;
    let signatures = 0,
      sends = 0,
      broadcasts = 0,
      reads = 0;
    const send = async (wire) => {
      sends++;
      assert.equal(wire.method, "GET");
      assert.equal(wire.url, plan.request.url);
      const credential = Credential.deserialize(wire.headers.Authorization);
      const groups = credential.payload.paymentGroup.map((b, i) =>
        i === plan.paymentIndex
          ? Buffer.from(b, "base64")
          : signature(decodeTransaction(Buffer.from(b, "base64")), sponsor),
      );
      globalThis.fetch = async (url, options) => {
        if (options?.method === "POST") {
          broadcasts++;
          assert.equal(url, "https://synthetic-rpc.example/v2/transactions");
          assert(Buffer.from(options.body).equals(Buffer.concat(groups)));
          for (const b of groups) {
            const s = decodeSignedTransaction(b),
              pub = createPublicKey({
                key: Buffer.concat([
                  Buffer.from("302a300506032b6570032100", "hex"),
                  s.txn.sender.publicKey,
                ]),
                format: "der",
                type: "spki",
              });
            assert(
              nodeVerify(null, bytesForSigning.transaction(s.txn), pub, s.sig),
            );
          }
          return Response.json({ txId: plan.inspection.transactionIds[0] });
        }
        reads++;
        return Response.json({ "confirmed-round": 1001 });
      };
      try {
        const receipt = await server.verify({ credential });
        return {
          status: 200,
          bodyText: '{"result":"synthetic"}',
          paymentReceipt: Receipt.serialize(receipt),
        };
      } finally {
        globalThis.fetch = originalFetch;
      }
    };
    const opts = {
      authorize: async () => {},
      readParams: async () => current,
      sign: async (...args) => {
        signatures++;
        return sign(...args);
      },
      send,
      now: () => NOW,
    };
    try {
      const out = await executeNativeAlgorandCharge(store, "one", plan, opts);
      assert.equal(out.state, "merchant_acknowledged");
      assert.equal(out.chainConfirmed, false);
      assert.equal(plan.inspection.buyerFeeMicroAlgo, sponsored ? "0" : "1000");
      assert.equal(
        plan.inspection.sponsorFeeMicroAlgo,
        sponsored ? "2000" : "0",
      );
      assert.equal(
        (await executeNativeAlgorandCharge(store, "one", plan, opts)).state,
        "merchant_acknowledged",
      );
      assert.equal(
        (await executeNativeAlgorandCharge(store, "another", plan, opts)).state,
        "unknown",
      );
      assert.deepEqual(
        { signatures, sends, broadcasts, reads },
        { signatures: 1, sends: 1, broadcasts: 1, reads: 1 },
      );
      assert.equal(globalThis.fetch, originalFetch);
    } finally {
      store.close();
      globalThis.fetch = originalFetch;
    }
  });
test("explicit realm may differ from host; lease, amounts, chain, sponsor mode and unknown fields are strict", async () => {
  const { request } = await actualOffer(true),
    good = prepare(request, true);
  assert.equal(good.inspection.limits.realm, "payments.example");
  for (const edit of [
    (r) => (r.amount = "1001"),
    (r) => (r.amount = "01"),
    (r) => (r.recipient = buyer.address),
    (r) => (r.methodDetails.asaId = "1"),
    (r) => (r.methodDetails.network = "algorand:testnet"),
    (r) => (r.methodDetails.lease = "AA=="),
    (r) => (r.methodDetails.challengeReference += "x"),
    (r) => (r.methodDetails.feePayerKey = buyer.address),
    (r) => delete r.methodDetails.suggestedParams,
    (r) => (r.methodDetails.suggestedParams.lastValid = 2001),
    (r) => (r.methodDetails.suggestedParams.fee = -1),
    (r) => (r.methodDetails.extra = "ignored"),
  ]) {
    const bad = structuredClone(request);
    edit(bad);
    assert.throws(() => prepare(bad, true));
  }
  assert.throws(() => prepare(request, false));
  assert.throws(() =>
    prepare(request, true, {
      limits: { ...good.inspection.limits, realm: "merchant.example" },
    }),
  );
  const p = { ...current, "min-fee": 2000 };
  assert.throws(() => checkNativeAlgorandCurrentParams(good, p, NOW));
  assert.throws(() =>
    checkNativeAlgorandCurrentParams(good, current, NOW + 60),
  );
});
test("positive byte fee works when full signed wire is covered; underfunded SDK congestion refuses before signer", async () => {
  for (const sponsored of [false, true]) {
    const normal = await actualOffer(sponsored, { fee: 1 });
    const p = prepare(normal.request, sponsored);
    assert.equal(
      p.inspection.terms.network_fee_micro_algo,
      p.inspection.networkFeeMicroAlgo,
    );
    assert(BigInt(p.inspection.networkFeeMicroAlgo) >= 1000n);
    const congested = await actualOffer(sponsored, { fee: 100 });
    assert.throws(
      () => prepare(congested.request, sponsored),
      /unsupported_algorand_charge|unsupported_native_charge|underfunds_signed_wire/,
    );
  }
});
test("unexpected sponsor signature, wrong buyer signature, rekey, lease, fee, note and signed amount never reach merchant", async () => {
  const { request } = await actualOffer(true);
  for (const mutate of [
    "sponsor",
    "signer",
    "rekey",
    "lease",
    "fee",
    "note",
    "amount",
  ]) {
    const p = prepare(request, true),
      store = new AlgorandManifestStore(":memory:");
    let sends = 0;
    try {
      const out = await executeNativeAlgorandCharge(store, "unsafe", p, {
        authorize: async () => {},
        readParams: async () => current,
        now: () => NOW,
        sign: async (raw, indexes) =>
          raw.map((b, i) => {
            if (i !== p.paymentIndex)
              return mutate === "sponsor"
                ? signature(decodeTransaction(b), sponsor)
                : null;
            const t = decodeTransaction(b);
            if (mutate === "rekey")
              t.rekeyTo = Address.fromString(sponsor.address);
            if (mutate === "lease") t.lease = new Uint8Array(32);
            if (mutate === "fee") t.fee = 1n;
            if (mutate === "note") t.note = Buffer.from("changed");
            if (mutate === "amount") t.assetTransfer.amount = 999n;
            return signature(t, mutate === "signer" ? sponsor : buyer);
          }),
        send: async () => {
          sends++;
          throw Error("must not send");
        },
      });
      assert.equal(out.state, "unknown");
      assert.equal(sends, 0);
    } finally {
      store.close();
    }
  }
});
test("restart/concurrent claims and lost merchant acknowledgment allow only exact read-only chain recovery", async () => {
  const { request } = await actualOffer(true),
    p = prepare(request, true),
    dir = mkdtempSync(join(tmpdir(), "algo-mpp-")),
    path = join(dir, "journal.sqlite");
  let a = new AlgorandManifestStore(path),
    b = new AlgorandManifestStore(path),
    signatures = 0,
    sends = 0,
    clock = NOW;
  const opts = {
    authorize: async () => {},
    readParams: async () => current,
    sign: async (...args) => {
      signatures++;
      return sign(...args);
    },
    send: async () => {
      sends++;
      throw Error("lost ACK");
    },
    now: () => clock,
  };
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        executeNativeAlgorandCharge(i % 2 ? a : b, "lost", p, opts),
      ),
    );
    a.close();
    b.close();
    a = new AlgorandManifestStore(path);
    b = new AlgorandManifestStore(path);
    clock += 900;
    assert.equal(
      (await executeNativeAlgorandCharge(a, "lost", p, opts)).state,
      "unknown",
    );
    assert.equal(
      (await executeNativeAlgorandCharge(a, "new-id", p, opts)).state,
      "unknown",
    );
    assert.equal(signatures, 1);
    assert.equal(sends, 1);
    const rows = new Map(
      p.raw.map((raw, i) => [
        p.inspection.transactionIds[i],
        {
          "confirmed-round": 1001,
          txn: {
            txn: transactionCodec.encode(
              decodeTransaction(Buffer.from(raw, "base64")),
              "json",
            ),
          },
        },
      ]),
    );
    let reads = 0;
    const read = async (q) => {
      reads++;
      assert.equal(q.method, "GET");
      return {
        status: 200,
        body: q.path.endsWith("/params")
          ? current
          : rows.get(q.path.split("/").at(-1)),
      };
    };
    const out = await confirmNativeAlgorandCharge(a, "lost", p, read);
    assert.equal(out.state, "chain_confirmed");
    assert.equal(out.resourceAcknowledged, false);
    assert.equal(reads, 3);
    rows.get(p.inspection.transactionIds[1])["confirmed-round"] = 1002;
    assert.equal(
      (await confirmNativeAlgorandCharge(a, "lost", p, read)).state,
      "unknown",
    );
    assert.equal(signatures, 1);
    assert.equal(sends, 1);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("decline, lost wallet ACK and post-sign expiry never transmit a credential; SDK does not fetch implicitly", async () => {
  const { request } = await actualOffer(),
    original = globalThis.fetch;
  for (const mode of ["decline", "wallet", "expiry"]) {
    const p = prepare(request),
      store = new AlgorandManifestStore(":memory:");
    let calls = 0,
      sends = 0,
      clock = NOW;
    globalThis.fetch = async () => {
      throw Error("SDK fetch forbidden");
    };
    try {
      const out = await executeNativeAlgorandCharge(store, "once", p, {
        authorize: async () => {
          if (mode === "decline") throw Error("declined");
        },
        readParams: async () => current,
        now: () => clock,
        sign: async (...args) => {
          calls++;
          if (mode === "wallet") throw Error("unknown wallet");
          const value = await sign(...args);
          if (mode === "expiry") clock += 60;
          return value;
        },
        send: async () => {
          sends++;
          throw Error("not expected");
        },
      });
      assert.equal(out.state, "unknown");
      assert.equal(sends, 0);
      assert.equal(calls, mode === "decline" ? 0 : 1);
    } finally {
      store.close();
      globalThis.fetch = original;
    }
  }
});

test("multi-offer SDK charge uses only selected original challenge and fences the same economic lease", async () => {
  const {request} = await actualOffer();
  const single = prepare(request);
  const chosen = single.challenge.wwwAuthenticate;
  const c = Challenge.deserialize(chosen);
  const unrelated = Challenge.serialize({...c, id:"another-method", method:"tempo", description:"comma, is data"});
  const over = Challenge.serialize({...c, id:"over-cap", request:{...request,amount:"1001"}});
  const challenge = {...single.challenge, bodyText:'{"altPayment":"opaque"}', paymentRequired:"e30=", wwwAuthenticate:[unrelated,chosen,over].join(", ")};
  const multi = prepare(request,false,{challenge});
  assert.equal(multi.authorityId,single.authorityId);
  assert.deepEqual(multi.raw,single.raw);
  assert.equal(multi.decoded.id,c.id);
  assert.notEqual(multi.inspection.challengeSha256,single.inspection.challengeSha256);
  const reordered = prepare(request,false,{challenge:{...challenge,wwwAuthenticate:[over,chosen,unrelated].join(", ")}});
  assert.equal(reordered.authorityId,single.authorityId);
  for(const raw of [chosen+", "+chosen,chosen+", "+Challenge.serialize({...c,id:"ambiguous"})]){
    assert.throws(()=>prepare(request,false,{challenge:{...challenge,wwwAuthenticate:raw}}));
  }
  let signs=0,sends=0;
  const journal=new AlgorandManifestStore(":memory:");
  const options={authorize:async()=>{},readParams:async()=>current,sign:async(...args)=>{signs++;return sign(...args);},send:async wire=>{
    sends++;
    const credential=Credential.deserialize(wire.headers.Authorization);
    assert.deepEqual(credential.challenge,multi.decoded);
    return {status:200,bodyText:'{"ok":true}',paymentReceipt:Receipt.serialize({method:"algorand",status:"success",timestamp:new Date(NOW*1000).toISOString(),reference:multi.inspection.transactionIds[0]})};
  },now:()=>NOW};
  try {
    assert.equal((await executeNativeAlgorandCharge(journal,"multi",multi,options)).state,"merchant_acknowledged");
    assert.equal((await executeNativeAlgorandCharge(journal,"reordered",reordered,options)).state,"unknown");
    assert.equal(signs,1);assert.equal(sends,1);
    // A generic store may implement once as insert-if-absent without equality.
    // A saved ACK must never be returned for a different same-operation plan.
    const permissive={once:()=>false,get:key=>journal.get(key)};
    assert.equal((await executeNativeAlgorandCharge(permissive,"multi",reordered,options)).state,"unknown");
    assert.equal((await executeNativeAlgorandCharge(permissive,"multi",multi,options)).state,"merchant_acknowledged");
    assert.equal(signs,1);assert.equal(sends,1);
  } finally {journal.close();}
});

test("generic insert-once store cannot reuse a saved ACK for a changed same-operation request", async () => {
 const {request}=await actualOffer(), original=prepare(request), journal=new AlgorandManifestStore(":memory:");
 let signs=0,sends=0;
 const options={authorize:async()=>{},readParams:async()=>current,sign:async(...args)=>{signs++;return sign(...args);},send:async()=>{sends++;return {status:200,bodyText:'{"ok":true}',paymentReceipt:Receipt.serialize({method:"algorand",status:"success",timestamp:new Date(NOW*1000).toISOString(),reference:original.inspection.transactionIds[0]})};},now:()=>NOW};
 try {
  assert.equal((await executeNativeAlgorandCharge(journal,"cached",original,options)).state,"merchant_acknowledged");
  const changed=prepare(request,false,{request:{url:"https://merchant.example/different-resource",method:"GET",body:new Uint8Array()}});
  assert.notEqual(changed.id,original.id);assert.equal(changed.authorityId,original.authorityId);
  const permissive={once:()=>false,get:key=>journal.get(key)};
  assert.equal((await executeNativeAlgorandCharge(permissive,"cached",changed,options)).state,"unknown");
  assert.equal(signs,1);assert.equal(sends,1);
 } finally {journal.close();}
});
