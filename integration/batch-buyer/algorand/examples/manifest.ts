/** Buyer-owned composition; no automatic wallet/payment transport is installed. */
import assert from "node:assert/strict";
import { verifyBatchRoute } from "@402signal/route-guard/batch";
import {
  executeAlgorandManifest,
  type AlgorandManifestPlan,
  type ManifestSigner,
  type ManifestOutcome,
} from "@402signal/algorand-batch-buyer/manifest";
import { type AlgorandManifestJournal } from "@402signal/algorand-batch-buyer/manifest-store";

export async function runObservedManifest(input: {
  journal: AlgorandManifestJournal;
  operationId: string;
  plan: AlgorandManifestPlan;
  proof: Omit<Parameters<typeof verifyBatchRoute>[0], "now">;
  /** Read-only/idempotent: independently verify the SAME retained router fee
   * authorization paid exactly3000USDC atomic to the configured router payee. */
  confirmRouterPayment: () => Promise<boolean>;
  /** Idempotent reservation keyed by operationId. Includes routing, merchant
   * spend and any customer-approved sponsor charge; never resets on unknown. */
  reserveBudget: (
    operationId: string,
    plan: AlgorandManifestPlan,
  ) => Promise<void>;
  readParams: () => Promise<unknown>;
  sign: ManifestSigner;
  /** Exactly one ordinary merchant request, redirect/retry/auto-payment disabled. */
  send: (url: string, payment: any) => Promise<ManifestOutcome>;
  now?: () => number;
}) {
  const clock = input.now ?? (() => Math.floor(Date.now() / 1000));
  return executeAlgorandManifest(input.journal, input.operationId, input.plan, {
    now: clock,
    readParams: input.readParams,
    sign: input.sign,
    send: input.send,
    authorize: async (plan) => {
      const proof = verifyBatchRoute({ ...input.proof, now: clock() });
      assert.equal(proof.profile, plan.profile);
      assert.equal(proof.request.url, plan.envelope.resource.url);
      assert.equal(proof.request.method, "GET");
      assert.deepEqual(
        JSON.parse(JSON.stringify(proof.buyer_limits)),
        JSON.parse(JSON.stringify(plan.limits)),
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(proof.terms)),
        JSON.parse(JSON.stringify(plan.manifest)),
      );
      assert.equal(
        await input.confirmRouterPayment(),
        true,
        "router payment remains unconfirmed",
      );
      await input.reserveBudget(input.operationId, plan);
    },
  });
}
