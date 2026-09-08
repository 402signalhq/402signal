import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Challenge } from "mppx";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  OwnerSessionController,
  SOLANA_SESSION_PROGRAM,
  SOLANA_USDC,
  SOLANA_GENESIS,
} from "../src/owner-session.mjs";
import {
  openSessionLocally,
  closeSessionLocally,
  prepareSessionClose,
  closeUnspentSessionLocally,
  registerOpenedSession,
} from "../src/owner-operator.mjs";
import { createNativeSessionMerchant } from "../src/merchant-session.mjs";
import {
  LocalBatchLedger,
  LocalOperationJournal,
} from "../../owner-runtime/local-ledger.mjs";
import {
  createMerchantSender,
  createCdpBatchProvider,
} from "../../owner-runtime/transport.mjs";
const codecs = await import(
  new URL(
    "./generated/payment-channels/accounts/channel.js",
    import.meta.resolve("@solana/mpp"),
  )
);
const helpers = await import(
  new URL("./server/session/on-chain.js", import.meta.resolve("@solana/mpp"))
);
const payer = await createKeyPairSignerFromPrivateKeyBytes(
    new Uint8Array(32).fill(7),
  ),
  operator = await createKeyPairSignerFromPrivateKeyBytes(
    new Uint8Array(32).fill(8),
  );
const bh = "11111111111111111111111111111111";
const programDataAddress = getBase58Decoder().decode(
    new Uint8Array(32).fill(9),
  ),
  programData = Buffer.alloc(45);
programData.writeUInt32LE(3);
const programRaw = Buffer.concat([
  Buffer.from([2, 0, 0, 0]),
  Buffer.from(getBase58Encoder().encode(programDataAddress)),
]);
function args() {
  const request = {
    cap: "4000",
    currency: SOLANA_USDC,
    decimals: 6,
    network: "mainnet",
    operator: operator.address,
    recipient: operator.address,
    programId: SOLANA_SESSION_PROGRAM,
    recentBlockhash: bh,
    recentSlot: "444444",
    minVoucherDelta: "1000",
  };
  return {
    wwwAuthenticate: Challenge.serialize(
      Challenge.from({
        id: "synthetic-session",
        realm: "merchant.example",
        method: "solana",
        intent: "session",
        request,
        expires: new Date(Date.now() + 60000).toISOString(),
      }),
    ),
    request: {
      url: "https://merchant.example/session",
      method: "GET",
      digest: "a".repeat(64),
    },
    policy: {
      payer: payer.address,
      operator: operator.address,
      recipient: operator.address,
      programDataAddress,
      programDataSha256: createHash("sha256").update(programData).digest("hex"),
      maximumOperatorOpenLamports: "5000000",
      depositAtomic: "4000",
      maxSessionAtomic: "4000",
      gracePeriod: 900,
      voucherExpiresAt: Math.floor(Date.now() / 1000) + 1800,
      salt: "42",
    },
  };
}
function rpcFixture(plan) {
  const records = new Map();
  let currentChannel = null;
  const token = (owner, amount) => ({
    owner,
    mint: SOLANA_USDC,
    uiTokenAmount: { amount: String(amount) },
  });
  const channel = (status, cumulative) => ({
    discriminator: 1,
    version: 1,
    bump: 1,
    status,
    salt: 42n,
    deposit: 4000n,
    settlement: {
      settled: BigInt(cumulative),
      payoutWatermark: BigInt(cumulative),
    },
    closureStartedAt: 0n,
    payerWithdrawnAt: 0n,
    gracePeriod: 900,
    distributionHash: Array(32).fill(0),
    payer: payer.address,
    payee: operator.address,
    authorizedSigner: payer.address,
    mint: SOLANA_USDC,
    rentPayer: operator.address,
    openSlot: 444444n,
  });
  const encode = (c) =>
    Buffer.from(codecs.getChannelEncoder().encode(c)).toString("base64");
  async function opened(credential) {
    const tx = getTransactionDecoder().decode(
        Buffer.from(credential.payload.transaction, "base64"),
      ),
      signatures = await operator.signTransactions([tx]);
    const complete = {
      ...tx,
      signatures: { ...tx.signatures, ...signatures[0] },
    };
    const wire = Buffer.from(getTransactionEncoder().encode(complete)).toString(
      "base64",
    );
    const signature = getBase58Decoder().decode(
      complete.signatures[operator.address],
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    const preBalances = message.staticAccounts.map(() => 10000000),
      postBalances = [...preBalances];
    postBalances[0] -= 4000000;
    records.set(signature, {
      slot: 444445,
      transaction: [wire, "base64"],
      meta: {
        err: null,
        fee: 5000,
        preBalances,
        postBalances,
        preTokenBalances: [token(payer.address, 10000)],
        postTokenBalances: [
          token(payer.address, 6000),
          token(plan.open.channelId, 4000),
        ],
      },
    });
    currentChannel = encode(channel(0, 0));
    return signature;
  }
  async function closed(credential) {
    const v = credential.payload.voucher;
    const settle = helpers.buildSettleAndSealInstructions({
      channelId: plan.open.channelId,
      merchantSigner: operator,
      programId: SOLANA_SESSION_PROGRAM,
      ...(v ? { voucher: { authorizedSigner: payer.address, signed: v } } : {}),
    });
    const distribute = await helpers.buildDistributeInstruction({
      channelState: {
        channelId: plan.open.channelId,
        payee: operator.address,
        payer: payer.address,
      },
      mint: SOLANA_USDC,
      programId: SOLANA_SESSION_PROGRAM,
      rentPayer: operator.address,
      splits: [],
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    });
    let message = createTransactionMessage({ version: 0 });
    message = setTransactionMessageFeePayer(operator.address, message);
    message = setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: bh, lastValidBlockHeight: 999999n },
      message,
    );
    message = appendTransactionMessageInstructions(
      [...settle.instructions, distribute],
      message,
    );
    const tx = await partiallySignTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(tx),
      compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
      signature = getBase58Decoder().decode(tx.signatures[operator.address]);
    const cumulative = v ? BigInt(v.data.cumulativeAmount) : 0n,
      preBalances = compiled.staticAccounts.map(() => 10000000),
      postBalances = [...preBalances];
    postBalances[0] -= 5000;
    records.set(signature, {
      slot: 444446,
      transaction: [wire, "base64"],
      meta: {
        err: null,
        fee: 5000,
        preBalances,
        postBalances,
        preTokenBalances: [
          token(payer.address, 6000),
          token(plan.open.channelId, 4000),
        ],
        postTokenBalances: [
          token(payer.address, 6000n + 4000n - cumulative),
          token(operator.address, cumulative),
        ],
      },
    });
    currentChannel = encode(channel(3, cumulative));
    return signature;
  }
  const rpc = async (method, params) => {
    if (method === "getGenesisHash")
      return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    if (method === "getTransaction")
      return structuredClone(records.get(params[0]));
    if (method === "getTokenAccountBalance")
      return { value: { decimals: 6, amount: "10000" } };
    if (method === "getBalance") return { value: 10000000 };
    if (method === "getFeeForMessage") return { value: 5000 };
    if (method === "getAccountInfo" && params[0] === SOLANA_SESSION_PROGRAM)
      return {
        value: {
          owner: "BPFLoaderUpgradeab1e11111111111111111111111",
          executable: true,
          data: [programRaw.toString("base64"), "base64"],
        },
      };
    if (method === "getAccountInfo" && params[0] === programDataAddress)
      return {
        value: {
          owner: "BPFLoaderUpgradeab1e11111111111111111111111",
          executable: false,
          data: [programData.toString("base64"), "base64"],
        },
      };
    if (method === "getAccountInfo")
      return {
        context: { slot: 444446 },
        value: currentChannel
          ? {
              owner: SOLANA_SESSION_PROGRAM,
              executable: false,
              data: [currentChannel, "base64"],
            }
          : null,
      };
    if (method === "getMinimumBalanceForRentExemption")
      return params[0] === 256 ? 2672640 : 2039280;
    throw Error("RPC method not allowed");
  };
  return { rpc, opened, closed, records, channel, encode };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "native-local-runtime-")),
    input = args(),
    url = "https://merchant.example/solana/session/sha256";
  const merchantLedger = new LocalBatchLedger(
      join(dir, "merchant"),
      "merchant-runtime",
    ),
    ownerLedger = new LocalBatchLedger(join(dir, "owner"), "owner-runtime");
  let chain,
    openCalls = 0,
    closeCalls = 0,
    readonlyCalls = 0,
    closingCredential;
  const rpc = async (method, params) => {
    if (method === "getMultipleAccounts") {
      const owners = [
        merchant.plan.open.channelId,
        payer.address,
        operator.address,
        "Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP",
      ];
      return {
        value: owners.map((owner) => {
          const raw = Buffer.alloc(165);
          Buffer.from(getBase58Encoder().encode(SOLANA_USDC)).copy(raw);
          Buffer.from(getBase58Encoder().encode(owner)).copy(raw, 32);
          raw[108] = 1;
          return {
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            executable: false,
            data: [raw.toString("base64"), "base64"],
          };
        }),
      };
    }
    if (method === "getLatestBlockhash")
      return {
        context: { slot: 444444 },
        value: { blockhash: bh, lastValidBlockHeight: 999999 },
      };
    if (method === "sendTransaction") {
      assert.equal(params[1].maxRetries, 0);
      const tx = getTransactionDecoder().decode(
          Buffer.from(params[0], "base64"),
        ),
        m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      if (m.instructions.length === 1) {
        openCalls++;
        return chain.opened({ payload: { transaction: params[0] } });
      }
      closeCalls++;
      return chain.closed(closingCredential);
    }
    readonlyCalls++;
    return chain.rpc(method, params);
  };
  const merchant = await createNativeSessionMerchant({
    migrateSchema: true,
    ledger: merchantLedger,
    rpc,
    url,
    policy: input.policy,
    perCallAtomic: "1000",
    maxCalls: 2,
  });
  const peerLedger = new LocalBatchLedger(
    join(dir, "merchant"),
    "merchant-runtime",
  );
  const peerMerchant = await createNativeSessionMerchant({
    migrateSchema: true,
    ledger: peerLedger,
    rpc,
    url,
    policy: input.policy,
    perCallAtomic: "1000",
    maxCalls: 2,
  });
  await merchant.request(url);
  chain = rpcFixture(merchant.plan);
  const controller = new OwnerSessionController(ownerLedger, merchant.plan);
  await controller.initialize();
  const server = createServer(async (req, res) => {
    const response = await merchant.request(
      url,
      req.headers.authorization,
      req.headers["replay-only"] === "1",
    );
    res.writeHead(response.status, response.headers);
    res.end(response.bodyText);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = "http://127.0.0.1:" + server.address().port;
  const sender = createMerchantSender(url, {
    native: true,
    fetch: async (_, init) => fetch(target, init),
  });
  return {
    dir,
    url,
    merchant,
    merchantLedger,
    peerMerchant,
    ownerLedger,
    controller,
    rpc,
    sender,
    chain,
    target,
    counts: () => ({ openCalls, closeCalls, readonlyCalls }),
    setClosing: (c) => {
      closingCredential = c;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      ownerLedger.close();
      merchantLedger.close();
      peerLedger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("owner SQLite + actual SDK cosign + HTTP merchant two vouchers and independent close", async () => {
  const s = await setup();
  try {
    const unsigned = await fetch(s.target);
    assert.equal(unsigned.status, 402);
    assert.equal(await unsigned.text(), "");
    assert.equal(
      unsigned.headers.get("www-authenticate"),
      s.merchant.plan.rawChallenge,
    );
    await s.controller.signOpen(payer, s.rpc);
    let operatorSigns = 0;
    const op = {
      address: operator.address,
      signTransactions: async (tx) => {
        operatorSigns++;
        return operator.signTransactions(tx);
      },
    };
    assert.equal(
      (
        await s.controller.sendOpen((credential) =>
          openSessionLocally({
            ledger: s.ownerLedger,
            plan: s.merchant.plan,
            credential,
            operator: op,
            rpc: s.rpc,
          }),
        )
      ).state,
      "provider_ack",
    );
    assert.equal(
      (await s.controller.confirmOpen(s.rpc)).state,
      "chain_confirmed",
    );
    const open = await s.ownerLedger.require("operator:open:credential");
    assert.equal(
      (await registerOpenedSession({ ledger: s.ownerLedger, send: s.sender }))
        .sessionOpened,
      true,
    );
    assert.equal(
      (await s.peerMerchant.request(s.url, open.authorization, true)).status,
      200,
    );
    for (let n = 1; n <= 2; n++)
      assert.equal(
        (await s.controller.voucher(payer, n, "1000", s.sender)).state,
        "voucher_accepted",
      );
    const current = await s.ownerLedger.require("voucher:2:credential"),
      before = s.counts();
    const replay = await fetch(s.target, {
      headers: { Authorization: current.authorization, "Replay-Only": "1" },
    });
    assert.equal(replay.status, 200);
    assert.equal(s.counts().readonlyCalls, before.readonlyCalls);
    const closeCandidate = {
      payload: { action: "close", voucher: current.payload.voucher },
    };
    for (const mode of ["missing-token", "fee"])
      await assert.rejects(
        prepareSessionClose({
          plan: s.merchant.plan,
          credential: closeCandidate,
          maximumCloseFeeLamports: "10000",
          rpc: async (m, p) => {
            if (mode === "missing-token" && m === "getMultipleAccounts")
              return { value: [null, null, null, null] };
            if (mode === "fee" && m === "getFeeForMessage")
              return { value: 10001 };
            return s.rpc(m, p);
          },
        }),
      );
    assert.equal(operatorSigns, 1);
    await s.controller.close(2, async (credential) => {
      s.setClosing(credential);
      const quote = await prepareSessionClose({
        plan: s.merchant.plan,
        credential,
        rpc: s.rpc,
        maximumCloseFeeLamports: "10000",
      });
      assert.equal(quote.quote.merchantAtomic, "2000");
      assert.equal(quote.quote.refundAtomic, "2000");
      return closeSessionLocally({
        ledger: s.ownerLedger,
        plan: s.merchant.plan,
        credential,
        operator: op,
        rpc: s.rpc,
        maximumCloseFeeLamports: "10000",
      });
    });
    const signature = (await s.ownerLedger.require("operator:close:ack"))
      .reference;
    assert.equal(
      (await s.controller.confirmClose(s.rpc, signature)).state,
      "chain_confirmed",
    );
    assert.equal(operatorSigns, 2);
    assert.equal(s.counts().openCalls, 1);
    assert.equal(s.counts().closeCalls, 1);
    const reopened = new LocalBatchLedger(
      join(s.dir, "owner"),
      "owner-runtime",
    );
    try {
      assert.equal((await reopened.require("progress")).state, "closed");
      await assert.rejects(
        new OwnerSessionController(reopened, s.merchant.plan).sendOpen(() =>
          assert.fail(),
        ),
      );
    } finally {
      reopened.close();
    }
  } finally {
    await s.close();
  }
});
test("operator broadcast lost acknowledgement stays fenced after reopening; no merchant or second send", async () => {
  const s = await setup();
  try {
    await s.controller.signOpen(payer, s.rpc);
    let broadcasts = 0;
    const rpc = async (m, p) => {
      if (m === "sendTransaction") {
        broadcasts++;
        await s.rpc(m, p);
        throw Error("lost");
      }
      return s.rpc(m, p);
    };
    assert.equal(
      (
        await s.controller.sendOpen((credential) =>
          openSessionLocally({
            ledger: s.ownerLedger,
            plan: s.merchant.plan,
            credential,
            operator,
            rpc,
          }),
        )
      ).state,
      "unknown",
    );
    const reopened = new LocalBatchLedger(
      join(s.dir, "owner"),
      "owner-runtime",
    );
    try {
      await assert.rejects(
        new OwnerSessionController(reopened, s.merchant.plan).sendOpen(() =>
          assert.fail(),
        ),
      );
      assert.ok(await reopened.require("operator:open:send-permit"));
      assert.equal(broadcasts, 1);
      assert.equal(
        await s.merchantLedger.get("merchant:open:response"),
        undefined,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await s.close();
  }
});
test("bare native open and recovery miss cannot create merchant state or call chain", async () => {
  const s = await setup();
  try {
    const { serializeSessionCredential } = await import("@solana/mpp/client");
    const auth = serializeSessionCredential({
      challenge: s.merchant.plan.challenge,
      payload: {
        action: "open",
        mode: "push",
        channelId: s.merchant.plan.open.channelId,
        signature: bh,
      },
    });
    const before = s.counts();
    assert.equal((await s.merchant.request(s.url, auth, true)).status, 503);
    assert.equal((await s.merchant.request(s.url, auth)).status, 503);
    assert.equal(s.counts().readonlyCalls, before.readonlyCalls);
    assert.equal((await s.merchantLedger.require("progress")).state, "new");
  } finally {
    await s.close();
  }
});
test("local operation journal grants one sender across connections and never reacquires unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-operation-"));
  const ledgers = Array.from(
    { length: 8 },
    () => new LocalBatchLedger(dir, "operation-runtime"),
  );
  try {
    const journals = ledgers.map((l) => new LocalOperationJournal(l));
    const input = {
      operationId: "a".repeat(64),
      kind: "settle",
      scope: {
        network: "eip155:8453",
        receiver: "0x" + "1".repeat(40),
        token: "0x" + "2".repeat(40),
      },
      payloadDigest: "b".repeat(64),
    };
    await journals[0].plan(input);
    const permits = await Promise.all(
      journals.map((j) => j.acquire(input.operationId)),
    );
    assert.equal(permits.filter(Boolean).length, 1);
    const token = permits.find(Boolean).sendToken;
    await journals[0].recordOutcome(input.operationId, token, {
      status: "unknown",
      evidenceDigest: "c".repeat(64),
    });
    assert.equal(await journals[1].acquire(input.operationId), undefined);
    await assert.rejects(
      journals[1].plan({ ...input, payloadDigest: "d".repeat(64) }),
    );
  } finally {
    ledgers.forEach((l) => l.close());
    rmSync(dir, { recursive: true, force: true });
  }
});
test("CDP provider pins host, sends one authenticated request and never retries lost settlement", async () => {
  let auth = 0,
    sends = 0;
  const provider = createCdpBatchProvider({
    authorization: async ({ url, method }) => {
      auth++;
      assert.equal(url, "https://api.cdp.coinbase.com/platform/v2/x402/settle");
      assert.equal(method, "POST");
      return { Authorization: "Bearer synthetic" };
    },
    fetch: async (url, init) => {
      sends++;
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      throw Error("lost");
    },
  });
  await assert.rejects(
    provider.settle(
      { payload: { type: "settle" } },
      { network: "eip155:8453" },
    ),
    /do not retry/,
  );
  assert.equal(auth, 1);
  assert.equal(sends, 1);
});

test("unused native deposit can be fully refunded without creating a payable voucher", async () => {
  const s = await setup();
  try {
    await s.controller.signOpen(payer, s.rpc);
    await s.controller.sendOpen((credential) =>
      openSessionLocally({
        ledger: s.ownerLedger,
        plan: s.merchant.plan,
        credential,
        operator,
        rpc: s.rpc,
      }),
    );
    await s.controller.confirmOpen(s.rpc);
    s.setClosing({ payload: { action: "close" } });
    const result = await closeUnspentSessionLocally({
      ledger: s.ownerLedger,
      plan: s.merchant.plan,
      operator,
      rpc: s.rpc,
      maximumCloseFeeLamports: "10000",
    });
    const proof = await s.controller.confirmClose(s.rpc, result.reference);
    assert.equal(proof.state, "chain_confirmed");
    assert.equal(proof.merchantAtomic, "0");
    assert.equal(proof.returnedBuyerAtomic, "4000");
    assert.equal(await s.ownerLedger.get("voucher:1:sign-intent"), undefined);
    assert.equal(s.counts().openCalls, 1);
    assert.equal(s.counts().closeCalls, 1);
  } finally {
    await s.close();
  }
});

test("SDK-encoded Channel discriminator one confirms open and unused refund; zero and closed-account tags refuse", async () => {
  const { observeSolanaOpen, observeSolanaClose } = await import('../src/owner-session.mjs');
  const s = await setup();
  const withTag = (tag) => async (method, params) => {
    const result = await s.rpc(method, params);
    if (method === 'getAccountInfo' && params[0] === s.merchant.plan.open.channelId && result.value) {
      const value = codecs.getChannelDecoder().decode(Buffer.from(result.value.data[0], 'base64'));
      assert.equal(value.discriminator, 1);
      result.value.data[0] = Buffer.from(codecs.getChannelEncoder().encode({ ...value, discriminator: tag })).toString('base64');
    }
    return result;
  };
  try {
    await s.controller.signOpen(payer, s.rpc);
    await s.controller.sendOpen((credential) => openSessionLocally({ ledger: s.ownerLedger, plan: s.merchant.plan, credential, operator, rpc: s.rpc }));
    const opening = (await s.ownerLedger.require('operator:open:signed')).signature;
    for (const tag of [0, 2, 255]) assert.equal((await observeSolanaOpen(withTag(tag), s.merchant.plan, opening)).state, 'unknown');
    assert.equal((await s.controller.confirmOpen(s.rpc)).state, 'chain_confirmed');
    s.setClosing({ payload: { action: 'close' } });
    const close = await closeUnspentSessionLocally({ ledger: s.ownerLedger, plan: s.merchant.plan, operator, rpc: s.rpc, maximumCloseFeeLamports: '10000' });
    for (const tag of [0, 2, 255]) assert.equal((await observeSolanaClose(withTag(tag), s.merchant.plan, close.reference)).state, 'unknown');
    const observed = await s.controller.confirmClose(s.rpc, close.reference);
    assert.equal(observed.state, 'chain_confirmed');
    assert.equal(observed.merchantAtomic, '0');
    assert.equal(observed.returnedBuyerAtomic, '4000');
    assert.equal(await s.ownerLedger.get('voucher:1:sign-intent'), undefined);
    assert.deepEqual({ opens: s.counts().openCalls, closes: s.counts().closeCalls }, { opens: 1, closes: 1 });
  } finally { await s.close(); }
});
