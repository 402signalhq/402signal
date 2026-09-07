import { prepareBaseX402 } from "../mpp-client/index.mjs";
import { check } from "./policy.mjs";
/** Optional seller-only x402 factory. Caller has already claimed the durable
 * signing stage and supplied a one-call account constrained to exact effects. */
export async function mppxSellerPayload({ challenge, account, request }) {
  const raw = JSON.stringify(challenge);
  const prepared = await prepareBaseX402({
    request: {
      url: request.url,
      method: request.method,
      body: Buffer.from(request.bodyText),
    },
    challenge: {
      status: 402,
      bodyText: raw,
      paymentRequired: Buffer.from(raw).toString("base64"),
    },
    expected: {
      amountAtomic: challenge.accepts[0].amount,
      recipient: challenge.accepts[0].payTo,
      payer: account.address,
    },
  });
  const made = await prepared.createPaymentPayload({
    authorize: () => ({ account }),
  });
  check(made.status === "credential_created", "credential_declined");
  return made.paymentPayload;
}
