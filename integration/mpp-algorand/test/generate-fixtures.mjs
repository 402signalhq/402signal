/** Generate public synthetic native charge vectors through the actual server SDK. */
import fs from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { Address } from "@algorandfoundation/algokit-utils";
import { algorand } from "@goplausible/algorand-mpp-sdk/server";
import { Challenge } from "mppx";
import { prepareNativeAlgorandCharge } from "../index.mjs";
const address = () =>
  new Address(
    generateKeyPairSync("ed25519")
      .publicKey.export({ format: "der", type: "spki" })
      .subarray(-32),
  ).toString();
const buyer = address(),
  recipient = address(),
  sponsor = address(),
  NOW = 1800000000,
  network = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  vectors = [],
  original = globalThis.fetch;
try {
  for (const sponsored of [false, true])
    for (const fee of [0, 1])
      for (const large of [false, true]) {
        const params = {
          fee,
          "min-fee": 1000,
          "last-round": large ? 4294967296 : 1000,
          "genesis-hash": network.slice(9),
          "genesis-id": "mainnet-v1.0",
        };
        globalThis.fetch = async () => Response.json(params);
        const method = algorand.charge({
          recipient,
          network,
          asaId: 31566704n,
          algodUrl: "https://synthetic.invalid",
          ...(sponsored
            ? {
                signerAddress: sponsor,
                signer: async () => {
                  throw Error("no fixture signer");
                },
              }
            : {}),
        });
        const offer = await method.request({
          credential: undefined,
          request: {
            amount: large ? "18446744073709551615" : "1000",
            currency: "USDC",
            recipient: "",
            methodDetails: { challengeReference: "", lease: "" },
            externalId: large ? "é".repeat(128) : "order-1",
          },
        });
        const limits = {
          network,
          asset: "31566704",
          recipient,
          realm: "payments.example",
          max_amount_atomic: offer.amount,
          max_network_fee_micro_algo: "20000",
          fee_payer: sponsored ? sponsor : null,
        };
        const challenge = {
          status: 402,
          bodyText: "",
          paymentRequired: null,
          wwwAuthenticate: Challenge.serialize({
            id: "synthetic-" + vectors.length,
            realm: limits.realm,
            method: "algorand",
            intent: "charge",
            request: offer,
            expires: new Date((NOW + 60) * 1000).toISOString(),
          }),
        };
        const request = {
          url: "https://merchant.example/paid?order=original&encoding=%61",
          merchant_profile: "algorand-mpp-charge-v1",
          buyer_limits: limits,
          require_route_binding: true,
        };
        const plan = prepareNativeAlgorandCharge({
          request: { url: request.url, method: "GET", body: new Uint8Array() },
          challenge,
          limits,
          buyer,
          now: NOW,
        });
        vectors.push({
          request,
          challenge,
          offer,
          buyer,
          now: NOW,
          expectedTerms: plan.inspection.terms,
          unsignedSizes: plan.raw.map((b) => Buffer.from(b, "base64").length),
          raw: plan.raw,
        });
      }
} finally {
  globalThis.fetch = original;
}
fs.writeFileSync(
  new URL("../../../tests/fixtures/algorand-mpp-charge.json", import.meta.url),
  JSON.stringify(vectors, null, 2) + "\n",
);
console.log(JSON.stringify({ publicVectors: vectors.length }));
