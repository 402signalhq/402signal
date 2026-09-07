import {
  createPublicKey,
  verify as verifyEd25519,
  createHash,
} from "node:crypto";
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase58Encoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
} from "@solana/kit";
import { serializeSessionCredential } from "@solana/mpp/client";
import {
  verifySolanaSessionDeployment,
  SOLANA_SESSION_PROGRAM,
  SOLANA_USDC,
  SOLANA_GENESIS,
} from "./owner-session.mjs";
const helpers = await import(
  new URL("./server/session/on-chain.js", import.meta.resolve("@solana/mpp"))
);
const check = (x, m) => {
  if (!x) throw Error(m);
};
const bytes = (x) => Buffer.from(x).toString("base64");
const sha = (x) => createHash("sha256").update(x).digest("hex");
function validSignature(address, message, signature) {
  try {
    return (
      signature?.length === 64 &&
      verifyEd25519(
        null,
        message,
        createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(getBase58Encoder().encode(address)),
          ]),
          format: "der",
          type: "spki",
        }),
        signature,
      )
    );
  } catch {
    return false;
  }
}
async function operatorSign({
  ledger,
  stage,
  plan,
  transaction,
  operator,
  rpc,
  maximumFeeLamports,
}) {
  check(
    operator.address === plan.policy.operator &&
      typeof operator.signTransactions === "function",
    "operator signer mismatch",
  );
  check((await rpc("getGenesisHash", [])) === SOLANA_GENESIS, "wrong chain");
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  check(
    message.staticAccounts[0] === operator.address &&
      !message.addressTableLookups?.length,
    "operator fee payer required",
  );
  const fee = await rpc("getFeeForMessage", [
    bytes(transaction.messageBytes),
    { commitment: "confirmed" },
  ]);
  check(
    Number.isSafeInteger(fee?.value) &&
      fee.value >= 0 &&
      /^[1-9][0-9]{0,15}$/.test(maximumFeeLamports) &&
      BigInt(fee.value) <= BigInt(maximumFeeLamports),
    "operator fee budget refused",
  );
  check(
    await ledger.once(stage + ":sign-permit", {
      messageBase64: bytes(transaction.messageBytes),
      feeLamports: String(fee.value),
    }),
    "operator signing already claimed",
  );
  const signatures = await operator.signTransactions([transaction]);
  check(
    signatures.length === 1 &&
      Object.keys(signatures[0]).length === 1 &&
      validSignature(
        operator.address,
        transaction.messageBytes,
        signatures[0][operator.address],
      ),
    "invalid operator signature",
  );
  const signed = {
    ...transaction,
    signatures: { ...transaction.signatures, ...signatures[0] },
  };
  for (const address of message.staticAccounts.slice(
    0,
    message.header.numSignerAccounts,
  ))
    check(
      validSignature(address, signed.messageBytes, signed.signatures[address]),
      "incomplete transaction signature",
    );
  const wire = bytes(getTransactionEncoder().encode(signed)),
    signature = getBase58Decoder().decode(signed.signatures[operator.address]);
  check(
    await ledger.once(stage + ":signed", {
      wire,
      signature,
      messageDigest: sha(signed.messageBytes),
      feeLamports: String(fee.value),
    }),
    "signed transaction already retained",
  );
  return { wire, signature };
}
async function broadcastOnce(ledger, stage, rpc, signed) {
  check(
    await ledger.once(stage + ":send-permit", {
      signature: signed.signature,
      wireDigest: sha(signed.wire),
    }),
    "transaction submission already claimed",
  );
  // One explicit call. RPC must not retry; maxRetries:0 also disables node rebroadcast.
  const reference = await rpc("sendTransaction", [
    signed.wire,
    {
      encoding: "base64",
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    },
  ]);
  check(reference === signed.signature, "broadcast outcome unknown");
  await ledger.once(stage + ":ack", { reference });
  return { reference };
}
/** Called only inside OwnerSessionController.sendOpen. Both owner signatures
 * and broadcast stay on the operator laptop; the merchant receives proof later. */
export async function openSessionLocally({
  ledger,
  plan,
  credential,
  operator,
  rpc,
}) {
  check(
    Date.now() >= plan.observedAt && Date.now() < plan.expiresAt,
    "original observation expired",
  );
  await verifySolanaSessionDeployment(rpc, plan);
  const tx = getTransactionDecoder().decode(
    Buffer.from(credential.payload.transaction, "base64"),
  );
  check(
    bytes(tx.messageBytes) === plan.messageBase64 &&
      validSignature(
        plan.policy.payer,
        tx.messageBytes,
        tx.signatures[plan.policy.payer],
      ) &&
      tx.signatures[plan.policy.operator] === null,
    "prepared buyer transaction required",
  );
  const signed = await operatorSign({
    ledger,
    stage: "operator:open",
    plan,
    transaction: tx,
    operator,
    rpc,
    maximumFeeLamports: plan.policy.maximumOperatorOpenLamports,
  });
  const payload = {
    ...credential.payload,
    transaction: signed.wire,
    signature: signed.signature,
  };
  await ledger.once("operator:open:credential", {
    payload,
    authorization: serializeSessionCredential({
      challenge: plan.challenge,
      payload,
    }),
  });
  return broadcastOnce(ledger, "operator:open", rpc, signed);
}
/** Read-only close quote builds exact cooperative seal+distribute. The initial
 * owner-operated profile uses the same operator and recipient, no splits. */
export async function prepareSessionClose({
  plan,
  credential,
  rpc,
  maximumCloseFeeLamports,
}) {
  check(
    plan.policy.operator === plan.policy.recipient,
    "initial operator must be recipient",
  );
  check((await rpc("getGenesisHash", [])) === SOLANA_GENESIS, "wrong chain");
  const voucher = credential.payload.voucher;
  check(credential.payload.action === "close", "close credential required");
  if (voucher) {
    check(
      voucher.data.channelId === plan.open.channelId &&
        voucher.data.expiresAt > Math.floor(Date.now() / 1000),
      "current original voucher required",
    );
    const helper = await import(
      new URL("./shared/voucher.js", import.meta.resolve("@solana/mpp"))
    );
    check(
      await helper.verifyVoucherSignature({
        signatureBase58: voucher.signature,
        signerBase58: plan.policy.payer,
        voucher: voucher.data,
      }),
      "voucher invalid",
    );
  }
  const cumulative = voucher ? BigInt(voucher.data.cumulativeAmount) : 0n;
  check(
    cumulative >= 0n && cumulative <= BigInt(plan.policy.depositAtomic),
    "payout cap",
  );
  const settle = helpers.buildSettleAndSealInstructions({
    channelId: plan.open.channelId,
    merchantSigner: createNoopSigner(plan.policy.recipient),
    programId: SOLANA_SESSION_PROGRAM,
    ...(voucher
      ? { voucher: { authorizedSigner: plan.policy.payer, signed: voucher } }
      : {}),
  });
  const distribute = await helpers.buildDistributeInstruction({
    channelState: {
      channelId: plan.open.channelId,
      payee: plan.policy.recipient,
      payer: plan.policy.payer,
    },
    mint: SOLANA_USDC,
    programId: SOLANA_SESSION_PROGRAM,
    rentPayer: plan.policy.operator,
    splits: [],
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  });
  // Distribution does not create token accounts. Require the fixed token accounts
  // to exist before signing so an extra rent-funded setup cannot be smuggled in.
  const tokenAccounts = await rpc("getMultipleAccounts", [
    distribute.accounts.slice(3, 7).map((a) => a.address),
    { encoding: "base64", commitment: "finalized" },
  ]);
  check(tokenAccounts?.value?.length === 4, "close token accounts unavailable");
  const expectedOwners = [
    plan.open.channelId,
    plan.policy.payer,
    plan.policy.recipient,
    "Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP",
  ];
  tokenAccounts.value.forEach((account, i) => {
    check(
      account?.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
        !account.executable,
      "existing close token account required",
    );
    const raw = Buffer.from(account.data[0], "base64");
    check(
      raw.length === 165 &&
        getBase58Decoder().decode(raw.subarray(0, 32)) === SOLANA_USDC &&
        getBase58Decoder().decode(raw.subarray(32, 64)) === expectedOwners[i] &&
        raw[108] === 1,
      "close token account scope",
    );
  });
  const program = await rpc("getAccountInfo", [
    SOLANA_SESSION_PROGRAM,
    { encoding: "base64", commitment: "finalized" },
  ]);
  const programBytes = Buffer.from(program?.value?.data?.[0] ?? "", "base64");
  check(
    program?.value?.executable &&
      program.value.owner === "BPFLoaderUpgradeab1e11111111111111111111111" &&
      programBytes.length === 36 &&
      programBytes.readUInt32LE(0) === 2 &&
      getBase58Decoder().decode(programBytes.subarray(4)) ===
        plan.policy.programDataAddress,
    "close program pointer changed",
  );
  const deployment = await rpc("getAccountInfo", [
    plan.policy.programDataAddress,
    { encoding: "base64", commitment: "finalized" },
  ]);
  check(
    deployment?.value?.owner ===
      "BPFLoaderUpgradeab1e11111111111111111111111" &&
      sha(Buffer.from(deployment.value.data[0], "base64")) ===
        plan.policy.programDataSha256,
    "close deployment changed",
  );
  const latest = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  let message = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(plan.policy.operator, message);
  message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: latest.value.blockhash,
      lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight),
    },
    message,
  );
  message = appendTransactionMessageInstructions(
    [...settle.instructions, distribute],
    message,
  );
  const transaction = compileTransaction(message),
    fee = await rpc("getFeeForMessage", [
      bytes(transaction.messageBytes),
      { commitment: "confirmed" },
    ]);
  check(
    Number.isSafeInteger(fee?.value) &&
      fee.value >= 0 &&
      /^[1-9][0-9]{0,15}$/.test(maximumCloseFeeLamports) &&
      BigInt(fee.value) <= BigInt(maximumCloseFeeLamports),
    "close fee exceeds cap",
  );
  return {
    transaction,
    maximumCloseFeeLamports,
    quote: {
      operatorFeeLamports: String(fee.value),
      merchantAtomic: cumulative.toString(),
      refundAtomic: (BigInt(plan.policy.depositAtomic) - cumulative).toString(),
      channelRent: "reclaim remains separate",
    },
  };
}
export async function closeSessionLocally({
  ledger,
  plan,
  credential,
  operator,
  rpc,
  maximumCloseFeeLamports,
}) {
  if (!credential.payload.voucher) {
    await ledger.require("open:confirmed");
    check(
      !(await ledger.get("voucher:1:sign-intent")) &&
        (await ledger.require("progress")).state === "close-inflight",
      "unspent close requires no signed voucher",
    );
  }
  const prepared = await prepareSessionClose({
    plan,
    credential,
    rpc,
    maximumCloseFeeLamports,
  });
  await ledger.once("operator:close:quote", prepared.quote);
  const signed = await operatorSign({
    ledger,
    stage: "operator:close",
    plan,
    transaction: prepared.transaction,
    operator,
    rpc,
    maximumFeeLamports: maximumCloseFeeLamports,
  });
  return broadcastOnce(ledger, "operator:close", rpc, signed);
}

/** Full refund before any voucher authority exists. Unknown signed-voucher
 * outcomes cannot use this path, even if no merchant response was retained. */
export async function closeUnspentSessionLocally({
  ledger,
  plan,
  operator,
  rpc,
  maximumCloseFeeLamports,
}) {
  await ledger.require("open:confirmed");
  check(
    !(await ledger.get("voucher:1:sign-intent")),
    "voucher authority already exists",
  );
  await ledger.transition("active:0", "close-inflight");
  const credential = {
    payload: { action: "close", channelId: plan.open.channelId },
  };
  check(
    await ledger.once("close:credential", credential),
    "close already prepared",
  );
  const result = await closeSessionLocally({
    ledger,
    plan,
    credential,
    operator,
    rpc,
    maximumCloseFeeLamports,
  });
  await ledger.once("close:ack", result);
  return result;
}
export async function registerOpenedSession({ ledger, send }) {
  await ledger.require("open:confirmed");
  const credential = await ledger.require("operator:open:credential");
  check(
    await ledger.once("merchant:open:send-permit", {
      authorizationDigest: sha(credential.authorization),
    }),
    "merchant registration already attempted",
  );
  try {
    const result = await send(credential);
    check(
      result.sessionOpened === true &&
        result.reference === credential.payload.signature,
      "merchant registration unknown",
    );
    await ledger.once("merchant:open:response", result);
    return result;
  } catch {
    return { state: "unknown", newPaymentAllowed: false };
  }
}

/** Recover merchant registration after its response was lost. Chain opening and
 * original submission permit must already exist; no signer or broadcast. */
export async function recoverOpenedSession({ledger,plan,recover}){
 await ledger.require('open:confirmed');await ledger.require('merchant:open:send-permit');
 const credential=await ledger.require('operator:open:credential');
 const prior=await ledger.get('merchant:open:response');if(prior){check(prior.sessionOpened===true&&prior.reference===credential.payload.signature,'registration mismatch');return {state:'merchant_registered'};}
 const authorizationDigest=sha(credential.authorization);let attempt;
 for(let n=1;n<=6;n++)if(await ledger.once('merchant:open:recovery:'+n,{authorizationDigest})){attempt='merchant:open:recovery:'+n;break;}
 check(attempt,'merchant recovery limit reached');
 try{
  const result=JSON.parse(JSON.stringify(await recover(JSON.parse(JSON.stringify(credential)))));
  check(result.recoveryOnly===true&&result.url===plan.request.url&&result.authorizationDigest===authorizationDigest&&typeof result.bodyText==='string'&&result.evidenceDigest===sha(JSON.stringify({url:plan.request.url,status:200,bodyText:result.bodyText,authorizationDigest}))&&JSON.stringify(result.body)===JSON.stringify(JSON.parse(result.bodyText))&&result.body?.sessionOpened===true&&result.body.reference===credential.payload.signature,'registration recovery mismatch');
  await ledger.once(attempt+':evidence',result);await ledger.once('merchant:open:response',result.body);return {state:'merchant_registered'};
 }catch{return {state:'unknown',newPaymentAllowed:false};}
}
