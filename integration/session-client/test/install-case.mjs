import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaseSessionClient } from "@402signal/session-client/base";
import {
  SolanaSessionClient,
  quoteSolanaSessionRent,
  verifySolanaSessionDeployment,
} from "@402signal/session-client/solana";
import {
  LocalBatchLedger,
  LocalOperationJournal,
} from "@402signal/session-client/ledger";
import { hash, readInitialObservation } from "@402signal/session-client";
import { createSessionTransport } from "@402signal/session-client/transport";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { Challenge, Receipt } from "mppx";
assert.equal(typeof createSessionTransport, "function");
assert.equal(typeof quoteSolanaSessionRent, "function");
assert.equal(typeof verifySolanaSessionDeployment, "function");
let now = 1800000000000;
Date.now = () => now;
for (const f of JSON.parse(
  readFileSync(new URL("./synthetic.json", import.meta.url)),
)) {
  now = 1800000000000;
  const directory = mkdtempSync(join(tmpdir(), "installed-session-")),
    id = "installed-" + f.rail,
    ledger = new LocalBatchLedger(directory, id);
  const rpc = async (m) => {
    if (m === "eth_chainId") return "0x2105";
    if (m === "eth_getCode") return "0x6000";
    if (m === "eth_getBlockByNumber")
      return { number: "0x100", hash: "0x" + "22".repeat(32) };
    if (m === "eth_call") return "0x" + "0".repeat(128);
    throw Error("no runtime external RPC");
  };
  const client =
    f.rail === "base"
      ? new BaseSessionClient(
          ledger,
          new LocalOperationJournal(ledger),
          rpc,
          f.plan,
          { policy: f.policy, initialObservation: f.proof },
        )
      : new SolanaSessionClient(ledger, f.plan, {
          policy: f.policy,
          initialObservation: f.proof,
        });
  await client.initialize();
  const owner =
    f.rail === "base"
      ? privateKeyToAccount("0x" + "07".repeat(32))
      : await createKeyPairSignerFromPrivateKeyBytes(
          new Uint8Array(32).fill(7),
        );
  // Only synthetic funding records here. Full chain-effect qualification is a
  // separate test; this test proves the installed package has no repo dependency.
  if (f.rail === "base") {
    await client.prepareDeposit(owner);
    await ledger.once("deposit:confirmed", { state: "chain_confirmed" });
    await ledger.transition("deposit-ready", "active:0");
  } else {
    await ledger.once("open:confirmed", { state: "chain_confirmed" });
    await ledger.transition("new", "active:0");
  }
  now += 3600000;
  for (let i = 1; i <= 3; i++) {
    const request = { url: f.policy.request.url, method: "GET", body: "" };
    const challenge =
      f.rail === "base"
        ? f.rawChallenge
        : Challenge.serialize(
            Challenge.from({
              ...f.plan.challenge,
              id: "installed-" + i,
              expires: new Date(now + 60000).toISOString(),
            }),
          );
    const result = await client.deliver(
      owner,
      i,
      request,
      challenge,
      async (packet) => ({
        status: 200,
        url: request.url,
        requestDigest: packet.request.requestDigest,
        authorizationDigest: hash(packet.authorization),
        bodyText: "{}",
        headers:
          f.rail === "base"
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
                    timestamp: new Date(now).toISOString(),
                  }),
                ),
              },
      }),
    );
    assert.equal(result.state, "voucher_accepted");
    assert.equal(result.chainSettled, false);
  }
  assert.deepEqual(await readInitialObservation(ledger), f.proof);
  assert.equal((await ledger.require("progress")).state, "active:3");
  ledger.close();
  console.log(f.rail + " installed3calls PASS");
}
