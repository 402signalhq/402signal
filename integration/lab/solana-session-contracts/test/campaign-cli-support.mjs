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
  prepareSolanaSession,
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
      payoutWatermark: 0n,
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

async function setup(originalChallenge) {
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
  if (originalChallenge) {
    const prepared = await prepareSolanaSession({
      wwwAuthenticate: originalChallenge,
      request: {
        url,
        method: "GET",
        digest: createHash("sha256")
          .update(JSON.stringify({ url, method: "GET", body: "" }))
          .digest("hex"),
      },
      policy: input.policy,
    });
    await merchantLedger.once("merchant:plan", prepared);
  }
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
export { setup, payer, operator, args, rpcFixture };
