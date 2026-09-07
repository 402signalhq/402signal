import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeFunctionData,
  encodeFunctionResult,
  decodeFunctionData,
  encodeEventTopics,
  encodeAbiParameters,
  parseAbi,
  keccak256,
} from "viem";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { BaseBatchController } from "../dist/src/base-batch-lifecycle.js";
import {
  BASE_BATCH,
  BASE_COLLECTOR,
  BASE_USDC,
  BASE_BATCH_ABI,
} from "../dist/src/base-batch-observer.js";
import { LocalBatchLedger, LocalOperationJournal } from "./local-ledger.mjs";
import { createLocalBaseCampaign } from "./base-owner.mjs";
const wallet = privateKeyToAccount("0x" + "11".repeat(32)),
  receiver = "0x" + "22".repeat(20),
  authorizer = "0x" + "33".repeat(20);
const code = "0x6000",
  zero = {
    balance: "0",
    claimed: "0",
    receiverClaimed: "0",
    receiverSettled: "0",
    withdrawAmount: "0",
    withdrawAt: "0",
    refundNonce: "0",
  };
const tokenAbi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
const hex = (n) => "0x" + n.toString(16),
  hash = (n) => "0x" + n.toString(16).padStart(64, "0");
function plan() {
  return {
    version: 1,
    config: {
      payer: wallet.address,
      payerAuthorizer: wallet.address,
      receiver,
      receiverAuthorizer: authorizer,
      token: BASE_USDC,
      withdrawDelay: 900,
      salt: "0x" + "44".repeat(32),
    },
    resource: "https://merchant.example/batch",
    perCallAtomic: "1000",
    depositAtomic: "4000",
    maxCalls: 3,
    expiresAt: Date.now() + 3600000,
    maximumBuyerGasWei: "0",
    contractCodeHash: keccak256(code),
    collectorCodeHash: keccak256(code),
  };
}
function chain(p) {
  const states = new Map([[100, { ...zero }]]),
    receipts = new Map(),
    transactions = new Map();
  let height = 100;
  const transfer = (from, to, value) => ({
    address: BASE_USDC,
    topics: encodeEventTopics({
      abi: tokenAbi,
      eventName: "Transfer",
      args: { from: from, to: to },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  });
  function append(payload) {
    const prev = states.get(height);
    height++;
    const state = { ...prev },
      txHash = hash(height),
      blockHash = hash(height + 1000),
      logs = [];
    let input;
    if (payload.type === "deposit") {
      state.balance = payload.deposit.amount;
      const auth = payload.deposit.authorization.erc3009Authorization;
      input = encodeFunctionData({
        abi: BASE_BATCH_ABI,
        functionName: "deposit",
        args: [p.config, BigInt(payload.deposit.amount), BASE_COLLECTOR, "0x"],
      });
      const nonce = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }],
          [computeChannelId(p.config, "eip155:8453"), BigInt(auth.salt)],
        ),
      );
      logs.push(
        transfer(
          wallet.address,
          BASE_COLLECTOR,
          BigInt(payload.deposit.amount),
        ),
        transfer(BASE_COLLECTOR, BASE_BATCH, BigInt(payload.deposit.amount)),
        {
          address: BASE_USDC,
          topics: encodeEventTopics({
            abi: tokenAbi,
            eventName: "AuthorizationUsed",
            args: { authorizer: wallet.address, nonce },
          }),
          data: "0x",
        },
      );
    } else if (payload.type === "claim") {
      const c = payload.claims[0];
      state.claimed = c.totalClaimed;
      state.receiverClaimed = c.totalClaimed;
      input = encodeFunctionData({
        abi: BASE_BATCH_ABI,
        functionName: "claimWithSignature",
        args: [
          [
            {
              voucher: {
                channel: p.config,
                maxClaimableAmount: BigInt(c.voucher.maxClaimableAmount),
              },
              signature: c.signature,
              totalClaimed: BigInt(c.totalClaimed),
            },
          ],
          "0x",
        ],
      });
    } else if (payload.type === "settle") {
      const amount =
        BigInt(state.receiverClaimed) - BigInt(state.receiverSettled);
      state.receiverSettled = state.receiverClaimed;
      input = encodeFunctionData({
        abi: BASE_BATCH_ABI,
        functionName: "settle",
        args: [p.config.receiver, p.config.token],
      });
      logs.push(transfer(BASE_BATCH, p.config.receiver, amount), {
        address: BASE_BATCH,
        topics: encodeEventTopics({
          abi: BASE_BATCH_ABI,
          eventName: "Settled",
          args: {
            receiver: p.config.receiver,
            token: p.config.token,
            sender: authorizer,
          },
        }),
        data: encodeAbiParameters([{ type: "uint128" }], [amount]),
      });
    } else {
      const amount = BigInt(payload.amount);
      state.balance = (BigInt(state.balance) - amount).toString();
      state.refundNonce = (BigInt(state.refundNonce) + 1n).toString();
      input = encodeFunctionData({
        abi: BASE_BATCH_ABI,
        functionName: "refundWithSignature",
        args: [p.config, amount, BigInt(payload.refundNonce), "0x"],
      });
      logs.push(transfer(BASE_BATCH, wallet.address, amount));
    }
    states.set(height, state);
    receipts.set(txHash, {
      transactionHash: txHash,
      blockHash,
      blockNumber: hex(height),
      status: "0x1",
      to: BASE_BATCH,
      from: authorizer,
      gasUsed: "0x100",
      effectiveGasPrice: "0x1",
      logs,
    });
    transactions.set(txHash, {
      hash: txHash,
      blockHash,
      blockNumber: hex(height),
      to: BASE_BATCH,
      from: authorizer,
      value: "0x0",
      input,
    });
    return txHash;
  }
  const rpc = async (method, args) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getCode") return code;
    if (method === "eth_getBlockByNumber") {
      const n = args[0] === "finalized" ? height : Number(BigInt(args[0]));
      return { number: hex(n), hash: hash(n + 1000) };
    }
    if (method === "eth_getTransactionReceipt")
      return structuredClone(receipts.get(args[0]));
    if (method === "eth_getTransactionByHash")
      return structuredClone(transactions.get(args[0]));
    if (method === "eth_call") {
      const d = decodeFunctionData({ abi: BASE_BATCH_ABI, data: args[0].data }),
        s = states.get(Number(BigInt(args[1])));
      let result;
      if (d.functionName === "channels")
        result = [BigInt(s.balance), BigInt(s.claimed)];
      else if (d.functionName === "receivers")
        result = [BigInt(s.receiverClaimed), BigInt(s.receiverSettled)];
      else if (d.functionName === "pendingWithdrawals")
        result = [BigInt(s.withdrawAmount), Number(s.withdrawAt)];
      else result = BigInt(s.refundNonce);
      return encodeFunctionResult({
        abi: BASE_BATCH_ABI,
        functionName: d.functionName,
        result,
      });
    }
    throw Error("unexpected RPC write or method");
  };
  return { rpc, append, receipts, transactions, states };
}

test("local owner SQLite executes exact SDK Base lifecycle across reopening with one provider call per stage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "base-local-runtime-")),
    p = plan(),
    c = chain(p);
  let campaign, peer;
  try {
    campaign = await createLocalBaseCampaign({
      directory: dir,
      campaignId: "base-local-runtime",
      plan: p,
      rpc: c.rpc,
    });
    let sends = 0,
      verifies = 0,
      signs = 0;
    const owner = {
      address: wallet.address,
      signTypedData: async (data) => {
        signs++;
        return wallet.signTypedData(data);
      },
    };
    const provider = {
      verify: async () => {
        verifies++;
        return { isValid: true };
      },
      settle: async (payload) => {
        sends++;
        return {
          success: true,
          network: "eip155:8453",
          transaction: c.append(payload.payload),
        };
      },
    };
    await campaign.controller.prepareDeposit(owner);
    await campaign.controller.sendDeposit(provider);
    assert.equal(
      (await campaign.controller.confirm("deposit")).state,
      "chain_confirmed",
    );
    peer = new LocalBatchLedger(dir, "base-local-runtime");
    const controller = new BaseBatchController(
      peer,
      new LocalOperationJournal(peer),
      c.rpc,
      p,
    );
    await controller.initialize();
    for (let n = 1; n <= 3; n++)
      assert.equal(
        (
          await controller.deliver(owner, n, "a".repeat(64), async () => ({
            chargedAmount: "1000",
            chargedCumulativeAmount: String(n * 1000),
          }))
        ).state,
        "voucher_accepted",
      );
    await controller.close(3);
    for (const kind of ["claim", "settle"]) {
      await controller.sendCloseOperation(kind, provider);
      assert.equal((await controller.confirm(kind)).state, "chain_confirmed");
    }
    await controller.sendRefund(provider);
    assert.equal((await controller.confirm("refund")).state, "chain_confirmed");
    assert.equal((await peer.require("progress")).state, "closed");
    assert.equal(signs, 4);
    assert.equal(sends, 4);
    assert.equal(verifies, 1);
    await assert.rejects(controller.sendRefund(provider));
    assert.equal(sends, 4);
  } finally {
    peer?.close();
    campaign?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unused Base deposit refunds fully on local journal without any delivery signing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "base-unused-local-")),
    p = plan(),
    c = chain(p);
  let campaign, peer;
  try {
    campaign = await createLocalBaseCampaign({
      directory: dir,
      campaignId: "base-unused-local",
      plan: p,
      rpc: c.rpc,
    });
    let signs = 0,
      sends = 0;
    const owner = {
      address: wallet.address,
      signTypedData: async (d) => {
        signs++;
        return wallet.signTypedData(d);
      },
    };
    const provider = {
      verify: async () => ({ isValid: true }),
      settle: async (x) => {
        sends++;
        return {
          success: true,
          network: "eip155:8453",
          transaction: c.append(x.payload),
        };
      },
    };
    await campaign.controller.prepareDeposit(owner);
    await campaign.controller.sendDeposit(provider);
    await campaign.controller.confirm("deposit");
    peer = new LocalBatchLedger(dir, "base-unused-local");
    const reopened = new BaseBatchController(
      peer,
      new LocalOperationJournal(peer),
      c.rpc,
      p,
    );
    await reopened.sendUnspentRefund(provider);
    assert.equal((await reopened.confirm("refund")).state, "chain_confirmed");
    assert.equal((await peer.require("refund:confirmed")).after.balance, "0");
    assert.equal(
      (await peer.require("refund:confirmed")).after.receiverSettled,
      "0",
    );
    assert.equal(signs, 2);
    assert.equal(sends, 2);
    assert.equal((await peer.require("progress")).state, "closed");
    await assert.rejects(reopened.sendUnspentRefund(provider));
  } finally {
    peer?.close();
    campaign?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
