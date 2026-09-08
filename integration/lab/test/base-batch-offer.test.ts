import test from "node:test";
import assert from "node:assert/strict";
import { BaseBatchMerchant } from "../src/base-batch-merchant.js";
import { BASE_USDC } from "../src/base-batch-observer.js";
const authorizer = "0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb",
  receiver = "0x2222222222222222222222222222222222222222",
  payer = "0x1111111111111111111111111111111111111111";
const url = "https://merchant.example/base/batch/sha256";
test("actual SDK merchant offer explicitly declares transfer method accepted by unchanged batch guard", async () => {
  let remoteCalls = 0;
  const provider: any = {
    getSupported: async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: "batch-settlement",
          network: "eip155:8453",
          extra: { receiverAuthorizer: authorizer },
        },
      ],
      extensions: [],
      signers: {},
    }),
    verify: async () => {
      remoteCalls++;
      throw Error("no payment");
    },
    settle: async () => {
      remoteCalls++;
      throw Error("no payment");
    },
  };
  const merchant = new BaseBatchMerchant(
    {} as any,
    {
      version: 1,
      campaignId: "offer-fixture",
      url,
      channelConfig: {
        payer,
        payerAuthorizer: payer,
        receiver,
        receiverAuthorizer: authorizer,
        token: BASE_USDC,
        withdrawDelay: 900,
        salt: ("0x" + "44".repeat(32)) as `0x${string}`,
      },
      perCallAtomic: "1000",
      maxCalls: 2,
      expiresAt: Date.now() + 60000,
    },
    provider,
  );
  // Isolate the quote boundary; existing PostgreSQL HTTP tests cover persistence.
  merchant.ledger.assertReady = async () => {};
  merchant.storage.assertReady = async () => {};
  merchant.ledger.bind = async () => {};
  merchant.ledger.once = async () => true;
  await merchant.initialize();
  const response = await merchant.request(url);
  assert.equal(response.status, 402);
  const envelope = response.body as any;
  assert.equal(envelope.accepts[0].extra.assetTransferMethod, "eip3009");
  assert.deepEqual(
    JSON.parse(
      Buffer.from(response.headers!["PAYMENT-REQUIRED"]!, "base64").toString(),
    ),
    envelope,
  );
  const modulePath = new URL(
    "../../sdk/route-guard/batch-profiles/base.mjs",
    import.meta.url,
  ).href;
  const { validateBaseBatchProfile } = await import(modulePath);
  const limits = {
    network: "eip155:8453",
    asset: BASE_USDC,
    recipient: receiver,
    receiver_authorizer: authorizer,
    withdraw_delay_seconds: 900,
    max_call_amount_atomic: "1000",
    max_capital_atomic: "4000",
    max_cumulative_amount_atomic: "2000",
  };
  assert.equal(
    validateBaseBatchProfile(envelope, { url }, limits).call_amount_atomic,
    "1000",
  );
  for (const method of [undefined, "permit2"]) {
    const bad = structuredClone(envelope);
    if (method === undefined) delete bad.accepts[0].extra.assetTransferMethod;
    else bad.accepts[0].extra.assetTransferMethod = method;
    assert.throws(() => validateBaseBatchProfile(bad, { url }, limits));
  }
  assert.equal(remoteCalls, 0);
});
