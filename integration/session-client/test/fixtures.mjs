import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, decodeFunctionData, encodeAbiParameters } from "viem";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { Challenge } from "mppx";
import { BaseSessionClient } from "../src/base.mjs";
import { SolanaSessionClient, prepareSolanaSession } from "../src/solana.mjs";
import {
  LocalBatchLedger,
  LocalOperationJournal,
} from "../internal/local-ledger.mjs";
import { BASE_BATCH_ABI, BASE_USDC } from "../internal/base-batch-observer.js";
import { SOLANA_USDC, SOLANA_SESSION_PROGRAM } from "../internal/native-v1.mjs";
import { validateBaseBatchProfile } from "../route-guard/batch-profiles/base.mjs";
import { validateSolanaSessionProfile } from "../route-guard/batch-profiles/solana.mjs";
import { canonical, digest, hash } from "../src/policy.mjs";
const sh = (...parts) =>
  createHash("sha256")
    .update(Buffer.concat(parts.map((x) => Buffer.from(x))))
    .digest();
const ed = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 91),
  ]),
  format: "der",
  type: "pkcs8",
});
const publicBytes = createPublicKey(ed)
  .export({ format: "der", type: "spki" })
  .subarray(-32);
export function signedObservation(
  profile,
  url,
  challenge,
  buyer_limits,
  terms,
) {
  const now = Math.floor(Date.now() / 1000),
    type = "402signal.route_decision.v5",
    origin = "synthetic.402signal.example/log";
  const key = Buffer.concat([Buffer.from([1]), publicBytes]),
    kid = sh(origin + "\n", key).subarray(0, 4),
    vkey = origin + "+" + kid.toString("hex") + "+" + key.toString("base64");
  const request = {
    url,
    merchant_profile: profile,
    buyer_limits,
    require_route_binding: true,
  };
  const binding = {
    model: "proof_carrying_batch_observation_v1",
    profile,
    request: { url, method: "GET", body_sha256: hash("") },
    buyer_limits,
    challenge,
    challenge_sha256: hash(canonical(challenge)),
    terms,
    observed_at: now,
    expires_at: now + 60,
  };
  const evidence = {
      evidence_version: 3,
      request_json: JSON.stringify(request),
      batch_binding: binding,
    },
    salt = "22".repeat(32),
    nonce = "33".repeat(32),
    commitment = sh(
      type + "\0",
      canonical(evidence),
      Buffer.from(salt, "hex"),
    ).toString("hex");
  const ts = new Date(now * 1000).toISOString().slice(0, 16) + ":00Z",
    leaf = sh(Buffer.from([0]), canonical({ type, ts, nonce, commitment }));
  const text = origin + "\n1\n" + leaf.toString("base64") + "\n",
    checkpoint =
      text +
      "\n— " +
      origin +
      " " +
      Buffer.concat([kid, sign(null, Buffer.from(text), ed)]).toString(
        "base64",
      ) +
      "\n";
  const response = {
    live: true,
    payable: true,
    url,
    status: 402,
    merchant_profile: profile,
    selected_payment: null,
    batch_binding: binding,
    batch_terms: terms,
    pq_trust: {
      transparency: {
        receipt: {
          leaf_hash: leaf.toString("hex"),
          index: 0,
          checkpoint,
          inclusion_path: [],
        },
        reveal: {
          type,
          event_version: type,
          ts,
          nonce,
          commitment,
          evidence,
          salt,
        },
      },
    },
  };
  return {
    routeResponseJson: JSON.stringify(response),
    routeRequestJson: JSON.stringify(request),
    trustedLogVkey: vkey,
    challenge,
  };
}
export const nativeOwner = await createKeyPairSignerFromPrivateKeyBytes(
  new Uint8Array(32).fill(7),
);
export const nativeOperator = await createKeyPairSignerFromPrivateKeyBytes(
  new Uint8Array(32).fill(8),
);
export const baseOwner = privateKeyToAccount("0x" + "07".repeat(32));
export function merchantChallenge(plan, body = "", id = randomUUID()) {
  return Challenge.serialize(
    Challenge.from({
      id,
      realm: new URL(plan.request.url).host,
      method: "solana",
      intent: "session",
      request: {
        ...plan.challenge.request,
        recentSlot: String(BigInt(plan.challenge.request.recentSlot) + 1n),
      },
      expires: new Date(Date.now() + 60000).toISOString(),
      digest: "sha-256=" + createHash("sha256").update(body).digest("base64"),
    }),
  );
}
export async function setup(rail, count = 3, method = "GET") {
  const url = "https://merchant.example/session",
    amount = "1000",
    deposit = String((count + 1) * 1000),
    now = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "continuation-"));
  chmodSync(directory, 0o700);
  const id = "session-" + randomUUID();
  const policy = {
    version: 2,
    maxCalls: count,
    perCallAtomic: amount,
    maxCumulativeAtomic: String(count * 1000),
    expiresAt: now + 4 * 3600000,
    request: { url, method, maxBodyBytes: method === "GET" ? 0 : 4096 },
  };
  let plan,
    proof,
    client,
    ledger = new LocalBatchLedger(directory, id),
    rawChallenge,
    rpc;
  if (rail === "solana") {
    const request = {
      cap: deposit,
      currency: SOLANA_USDC,
      decimals: 6,
      network: "mainnet",
      operator: nativeOperator.address,
      recipient: nativeOperator.address,
      programId: SOLANA_SESSION_PROGRAM,
      recentBlockhash: "11111111111111111111111111111111",
      recentSlot: "444444",
      minVoucherDelta: amount,
    };
    rawChallenge = Challenge.serialize(
      Challenge.from({
        id: "opening-" + id,
        realm: "merchant.example",
        method: "solana",
        intent: "session",
        request,
        expires: new Date(now + 60000).toISOString(),
      }),
    );
    const ownerPolicy = {
      payer: nativeOwner.address,
      operator: nativeOperator.address,
      recipient: nativeOperator.address,
      programDataAddress: nativeOperator.address,
      programDataSha256: "11".repeat(32),
      maximumOperatorOpenLamports: "5000000",
      depositAtomic: deposit,
      maxSessionAtomic: deposit,
      gracePeriod: 900,
      voucherExpiresAt: Math.floor(now / 1000) + 8 * 3600,
      salt: "42",
    };
    plan = await prepareSolanaSession({
      wwwAuthenticate: rawChallenge,
      request: {
        url,
        method: "GET",
        digest: hash(canonical({ url, method: "GET", body: "" })),
      },
      policy: ownerPolicy,
    });
    const limits = {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: SOLANA_USDC,
      recipient: nativeOperator.address,
      operator: nativeOperator.address,
      program_id: SOLANA_SESSION_PROGRAM,
      max_session_cap_atomic: deposit,
    };
    proof = signedObservation(
      "solana-mpp-session-v1",
      url,
      {
        status: 402,
        bodyText: "",
        paymentRequired: null,
        wwwAuthenticate: rawChallenge,
      },
      limits,
      validateSolanaSessionProfile(request, { url }, limits),
    );
    client = new SolanaSessionClient(ledger, plan, {
      policy,
      initialObservation: proof,
    });
  } else {
    const config = {
      payer: baseOwner.address,
      payerAuthorizer: baseOwner.address,
      receiver: "0x1111111111111111111111111111111111111111",
      receiverAuthorizer: "0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb",
      token: BASE_USDC,
      withdrawDelay: 900,
      salt: "0x" + "42".repeat(32),
    };
    plan = {
      version: 1,
      config,
      resource: url,
      perCallAtomic: amount,
      depositAtomic: deposit,
      maxCalls: count,
      expiresAt: now + 60000,
      maximumBuyerGasWei: "0",
      contractCodeHash: keccak256("0x6000"),
      collectorCodeHash: keccak256("0x6000"),
    };
    const envelope = {
      x402Version: 2,
      resource: { url },
      accepts: [
        {
          scheme: "batch-settlement",
          network: "eip155:8453",
          asset: BASE_USDC,
          payTo: config.receiver,
          amount,
          maxTimeoutSeconds: 300,
          extra: {
            name: "USD Coin",
            version: "2",
            assetTransferMethod: "eip3009",
            receiverAuthorizer: config.receiverAuthorizer,
            withdrawDelay: 900,
          },
        },
      ],
    };
    rawChallenge = JSON.stringify(envelope);
    const limits = {
      network: "eip155:8453",
      asset: BASE_USDC,
      recipient: config.receiver,
      receiver_authorizer: config.receiverAuthorizer,
      withdraw_delay_seconds: 900,
      max_call_amount_atomic: amount,
      max_capital_atomic: deposit,
      max_cumulative_amount_atomic: String(count * 1000),
    };
    proof = signedObservation(
      "base-x402-batch-v1",
      url,
      {
        status: 402,
        bodyText: rawChallenge,
        paymentRequired: null,
        wwwAuthenticate: null,
      },
      limits,
      validateBaseBatchProfile(envelope, { url }, limits),
    );
    rpc = async (method, params) => {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBlockByNumber")
        return { number: "0x100", hash: "0x" + "22".repeat(32) };
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_call") {
        const { functionName } = decodeFunctionData({
          abi: BASE_BATCH_ABI,
          data: params[0].data,
        });
        return encodeAbiParameters(
          functionName === "refundNonce"
            ? [{ type: "uint256" }]
            : [
                { type: "uint128" },
                {
                  type:
                    functionName === "pendingWithdrawals"
                      ? "uint40"
                      : "uint128",
                },
              ],
          functionName === "refundNonce" ? [0n] : [0n, 0n],
        );
      }
      throw Error("unexpected fixture RPC " + method);
    };
    client = new BaseSessionClient(
      ledger,
      new LocalOperationJournal(ledger),
      rpc,
      plan,
      { policy, initialObservation: proof },
    );
  }
  await client.initialize();
  async function funded() {
    // Representative finalized funding records: the underlying unchanged v1
    // observers have their own actual transaction/account-effect suites.
    if (rail === "base") {
      await client.prepareDeposit(baseOwner);
      await ledger.once("deposit:confirmed", {
        state: "chain_confirmed",
        transactionHash: "0x" + "ab".repeat(32),
      });
      await ledger.transition("deposit-ready", "active:0");
    } else {
      await ledger.once("open:confirmed", {
        state: "chain_confirmed",
        transactionSignature: "synthetic-finalized-opening",
      });
      await ledger.transition("new", "active:0");
    }
  }
  async function reopen() {
    const l = new LocalBatchLedger(directory, id);
    const c =
      rail === "base"
        ? new BaseSessionClient(l, new LocalOperationJournal(l), rpc, plan, {
            policy,
            initialObservation: proof,
          })
        : new SolanaSessionClient(l, plan, {
            policy,
            initialObservation: proof,
          });
    await c.initialize();
    return { client: c, ledger: l };
  }
  return {
    rail,
    policy,
    plan,
    proof,
    rawChallenge,
    client,
    ledger,
    directory,
    id,
    funded,
    reopen,
    owner: rail === "base" ? baseOwner : nativeOwner,
  };
}
