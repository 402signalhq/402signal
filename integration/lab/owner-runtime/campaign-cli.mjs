import { readFileSync, lstatSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { LocalBatchLedger } from "./local-ledger.mjs";
import {
  strictJson,
  canonical,
  https,
  check,
} from "../../reference-buyer/policy.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (x) => createHash("sha256").update(x).digest("hex");
const amount = (x) => {
  check(
    typeof x === "string" && /^(0|[1-9][0-9]{0,15})$/.test(x),
    "invalid_budget",
  );
  return BigInt(x);
};
export const requiredSources = [
  "integration/lab/owner-runtime/campaign-cli.mjs",
  "integration/lab/owner-runtime/local-ledger.mjs",
  "integration/lab/owner-runtime/base-owner.mjs",
  "integration/lab/owner-runtime/transport.mjs",
  "integration/lab/owner-runtime/merchant-recovery.mjs",
  "integration/lab/solana-session-contracts/src/owner-session.mjs",
  "integration/lab/solana-session-contracts/src/owner-operator.mjs",
  "integration/lab/solana-session-contracts/package-lock.json",
  "integration/reference-buyer/base-buyer.mjs",
  "integration/reference-buyer/journal.mjs",
  "integration/reference-buyer/policy.mjs",
  "integration/reference-buyer/confirmation.mjs",
  "integration/reference-buyer/package-lock.json",
  "sdk/route-guard/client.mjs",
  "sdk/route-guard/file-store.mjs",
  "sdk/route-guard/batch.mjs",
  "sdk/route-guard/batch-profiles/base.mjs",
  "sdk/route-guard/batch-profiles/solana.mjs",
  "sdk/route-guard/batch-profiles/algorand.mjs",
  "sdk/route-guard/batch-profiles/algorand-generic.mjs",
  "integration/lab/dist/src/base-batch-ledger.js",
  "sdk/route-guard/index.mjs",
  "sdk/route-guard/internal-json.mjs",
  "sdk/route-guard/recovery.mjs",
  "integration/lab/sdk/route-guard/internal-json.mjs",
  "integration/lab/dist/src/base-batch-lifecycle.js",
  "integration/lab/dist/src/base-batch-observer.js",
  "integration/lab/dist/src/batch-operation-runner.js",
  "integration/lab/package-lock.json",
];
const STAGES = new Set([
  "plan",
  "route",
  "route-after-deposit",
  "recover-route-after-deposit",
  "confirm-route-after-deposit",
  "recover-route",
  "recover-register",
  "recover-delivery-1",
  "recover-delivery-2",
  "recover-delivery-3",
  "close-empty",
  "confirm-route",
  "status",
  "preflight",
  "open",
  "confirm-open",
  "register",
  "deliver-1",
  "deliver-2",
  "deliver-3",
  "close",
  "confirm-close",
  "refund-unused",
  "deposit",
  "confirm-deposit",
  "claim",
  "confirm-claim",
  "settle",
  "confirm-settle",
  "refund",
  "confirm-refund",
]);
const SIGNING = new Set([
  "route",
  "route-after-deposit",
  "open",
  "deliver-1",
  "deliver-2",
  "deliver-3",
  "close",
  "refund-unused",
  "deposit",
]);
const FUNDED = new Set([
  "open",
  "deposit",
  "deliver-1",
  "deliver-2",
  "deliver-3",
]);
function configCheck(c) {
  check(
    c?.version === 1 && /^[A-Za-z0-9_-]{8,64}$/.test(c.campaignId),
    "invalid_campaign",
  );
  check(
    ["base-x402-batch-v1", "solana-mpp-session-v1"].includes(c.profile),
    "unsupported_profile",
  );
  check(
    typeof c.directory === "string" && c.directory === resolve(c.directory),
    "absolute_private_directory_required",
  );
  check(
    Number.isSafeInteger(c.expiresAt) &&
      c.expiresAt > 0 &&
      Number.isInteger(c.maxCalls) &&
      c.maxCalls >= 2 &&
      c.maxCalls <= 3,
    "bounded_campaign_required",
  );
  https(c.url);
  https(c.router.url);
  https(c.router.rpcUrl);
  check(
    c.router.feeAtomic === "3000" &&
      c.router.recoveryProfile === "http-route-v1",
    "exact_route_fee_required",
  );
  check(
    typeof c.trustedLogVkey === "string" && c.trustedLogVkey.length < 20000,
    "trusted_log_key_required",
  );
  check(
    [1, 2].includes(c.maxRouteObservations ?? 1) &&
      ((c.maxRouteObservations ?? 1) === 1 ||
        c.profile === "base-x402-batch-v1"),
    "route_observation_bound",
  );
  check(
    (c.maxRouteObservations ?? 1) !== 2 ||
      (c.depositAtomic === "4000" &&
        c.maxCalls === 2 &&
        c.perCallAtomic === "1000" &&
        c.budget.maximumUSDCAtomic === "10000"),
    "reviewed_two_observation_budget",
  );
  check(
    amount(c.budget.maximumUSDCAtomic) >=
      BigInt(c.maxRouteObservations ?? 1) * 3000n + amount(c.depositAtomic) &&
      amount(c.depositAtomic) >= amount(c.perCallAtomic) * BigInt(c.maxCalls) &&
      amount(c.perCallAtomic) > 0n,
    "capital_budget_exceeded",
  );
  check(
    amount(c.budget.maximumOperatorLamports) >= 0n &&
      amount(c.maximumCloseFeeLamports) >= 0n,
    "native_budget_required",
  );
  check(
    /^[0-9a-f]{64}$/.test(c.factorySha256) &&
      /^[0-9a-f]{40}$/.test(c.sourceCommit),
    "source_pins_required",
  );
  for (const name of requiredSources)
    check(typeof c.sources?.[name] === "string", "required_source_pin_missing");
  check(Object.keys(c.sources).length <= 1000, "source_manifest_bound");
  for (const [name, digest] of Object.entries(c.sources)) {
    check(
      /^[A-Za-z0-9_./-]+$/.test(name) &&
        !name.split("/").includes("..") &&
        !name.startsWith("/") &&
        /^[0-9a-f]{64}$/.test(digest),
      "invalid_source_pin",
    );
    const path = resolve(ROOT, name);
    check(!relative(ROOT, path).startsWith(".."), "source_path_escape");
    check(sha(readFileSync(path)) === digest, "source_pin_changed");
  }
  if (c.profile === "solana-mpp-session-v1") {
    const p = c.nativePolicy,
      l = c.buyerLimits;
    check(c.maxCalls === 2, "native_two_call_lab_profile");
    check(
      p.depositAtomic === c.depositAtomic &&
        p.maxSessionAtomic === l.max_session_cap_atomic &&
        p.operator === l.operator &&
        p.recipient === l.recipient &&
        p.operator === p.recipient,
      "native_policy_binding",
    );
    check(
      amount(c.budget.maximumOperatorLamports) >=
        amount(p.maximumOperatorOpenLamports) +
          amount(c.maximumCloseFeeLamports),
      "operator_budget_exceeded",
    );
  } else {
    if (new URL(c.url).pathname === "/base/batch/sha256")
      check(
        c.maxCalls === 2 && c.perCallAtomic === "1000",
        "reviewed_base_lab_two_call_profile",
      );
    const p = c.basePlan,
      l = c.buyerLimits;
    check(
      p.resource === c.url &&
        p.perCallAtomic === c.perCallAtomic &&
        p.depositAtomic === c.depositAtomic &&
        p.maxCalls === c.maxCalls &&
        p.expiresAt === c.expiresAt &&
        p.maximumBuyerGasWei === "0",
      "base_plan_binding",
    );
    for (const [a, b] of [
      [p.config.receiver, l.recipient],
      [p.config.receiverAuthorizer, l.receiver_authorizer],
      [p.config.token, l.asset],
    ])
      check(a.toLowerCase() === b.toLowerCase(), "base_scope_binding");
    check(
      p.config.withdrawDelay === l.withdraw_delay_seconds &&
        amount(c.perCallAtomic) <= amount(l.max_call_amount_atomic) &&
        amount(c.depositAtomic) <= amount(l.max_capital_atomic) &&
        amount(c.perCallAtomic) * BigInt(c.maxCalls) <=
          amount(l.max_cumulative_amount_atomic),
      "base_limits_binding",
    );
    check(
      c.budget.maximumOperatorLamports === "0" &&
        c.maximumCloseFeeLamports === "0",
      "base_zero_native_budget",
    );
  }
  return c;
}
const requestJson = (c) =>
  JSON.stringify({
    url: c.url,
    merchant_profile: c.profile,
    buyer_limits: c.buyerLimits,
    require_route_binding: true,
    ...(c.labTest ? { lab_test: c.labTest } : {}),
  });
const signingAllowed = (stage) => SIGNING.has(stage);
function safeState(x, fallback) {
  return typeof x?.state === "string" && /^[a-z0-9:_-]{1,64}$/.test(x.state)
    ? x.state
    : fallback;
}
/** Every invocation is one explicit stage. Factory is operator-reviewed local code,
 * hash-pinned here; it supplies keys only for the requested signer stage. */
export async function runCampaign({
  stage,
  config,
  factoryPath,
  reference,
  env = process.env,
}) {
  check(STAGES.has(stage), "explicit_stage_required");
  check(
    reference === undefined ||
      ([
        "confirm-deposit",
        "confirm-claim",
        "confirm-settle",
        "confirm-refund",
      ].includes(stage) &&
        /^0x[0-9a-fA-F]{64}$/.test(reference)),
    "readonly_reference_scope",
  );
  const c = configCheck(structuredClone(config));
  check(
    ![
      "route-after-deposit",
      "recover-route-after-deposit",
      "confirm-route-after-deposit",
    ].includes(stage) ||
      (c.maxRouteObservations === 2 && c.profile === "base-x402-batch-v1"),
    "second_observation_not_enabled",
  );
  if (stage === "plan")
    return {
      state: "planned",
      profile: c.profile,
      campaignId: c.campaignId,
      routeFeeAtomic: "3000",
      maximumRouteObservations: c.maxRouteObservations ?? 1,
      maximumRouteFeesAtomic: String((c.maxRouteObservations ?? 1) * 3000),
      depositAtomic: c.depositAtomic,
      maxCalls: c.maxCalls,
      maximumUSDCAtomic: c.budget.maximumUSDCAtomic,
      maximumOperatorLamports: c.budget.maximumOperatorLamports,
      paidActions: 0,
    };
  check(
    env.BATCH_OWNER_ACK === "reviewed-once-no-retry",
    "owner_acknowledgement_required",
  );
  const control = new LocalBatchLedger(c.directory, "campaign-control");
  let feeJournal, batchLedger;
  try {
    await control.bind(c);
    if (stage === "status")
      return {
        state: safeState(await newState(c), "prepared"),
        privateEvidenceRetained: true,
        newPaymentAllowed: false,
      };
    if (
      FUNDED.has(stage) ||
      stage === "route" ||
      stage === "route-after-deposit"
    )
      check(Date.now() < c.expiresAt, "campaign_expired");
    const factory = resolve(factoryPath ?? "");
    check(
      factoryPath &&
        lstatSync(factory).isFile() &&
        !lstatSync(factory).isSymbolicLink() &&
        sha(readFileSync(factory)) === c.factorySha256,
      "operator_factory_pin_changed",
    );
    const module = await import(pathToFileURL(factory).href);
    check(
      typeof module.createRuntime === "function",
      "operator_factory_required",
    );
    const runtime = await module.createRuntime({
      config: structuredClone(c),
      stage,
      signingAllowed: signingAllowed(stage),
    });
    check(
      runtime &&
        typeof runtime.fetch === "function" &&
        typeof runtime.baseRpc === "function",
      "bounded_owner_transport_required",
    );
    const { RouteClient, classifyRouteResponse } = await import(
      "../../../sdk/route-guard/client.mjs"
    );
    const { FileAttemptStore } = await import(
      "../../../sdk/route-guard/file-store.mjs"
    );
    const { verifyBatchRoute } = await import(
      "../../../sdk/route-guard/batch.mjs"
    );
    const { BaseBuyer } = await import("../../reference-buyer/base-buyer.mjs");
    const { BuyerJournal } = await import("../../reference-buyer/journal.mjs");
    const feePolicy = {
      buyerAddress: c.router.buyerAddress,
      routerUrl: c.router.url,
      routerPayTo: c.router.payTo,
      rpcUrl: c.router.rpcUrl,
      campaignMaximumAtomic: String((c.maxRouteObservations ?? 1) * 3000),
      buyerNativeFeeAtomic: "0",
      sellers: [
        {
          id: "route-fee-only",
          url: c.router.url,
          method: "GET",
          payTo: c.router.payTo,
          maximumAtomic: "3000",
          maxLifetimeSeconds: 60,
        },
      ],
    };
    feeJournal = new BuyerJournal(join(c.directory, "route-fee"), feePolicy);
    const unavailable = async () => {
      throw Error("read_only_stage");
    };
    const account =
      stage === "route" || stage === "route-after-deposit"
        ? runtime.routeAccount
        : { address: c.router.buyerAddress, signTypedData: unavailable };
    const buyer = new BaseBuyer({
      account,
      journal: feeJournal,
      policy: feePolicy,
      rpc: runtime.baseRpc,
      fetch: runtime.fetch,
    });
    const client = new RouteClient({
      store: new FileAttemptStore(join(c.directory, "route-attempts")),
      routerUrl: c.router.url,
      recoveryProfile: c.router.recoveryProfile,
      customerKey: env.REFERENCE_BUYER_CUSTOMER_KEY,
      fetch: runtime.fetch,
    });
    const id = c.campaignId,
      body = requestJson(c);
    const secondStages = new Set([
      "route-after-deposit",
      "recover-route-after-deposit",
      "confirm-route-after-deposit",
    ]);
    const second = secondStages.has(stage);
    check(
      !second ||
        (c.maxRouteObservations === 2 && c.profile === "base-x402-batch-v1"),
      "second_observation_not_enabled",
    );
    const deliveryRouteId = sha(id + "\npost-finalized-delivery-observation");
    const routeId = second ? deliveryRouteId : id;
    const routePrefix = second ? "route:after-deposit" : "route";
    const fundingEvidence = async () => {
      const ledger = new LocalBatchLedger(join(c.directory, "batch"), id);
      try {
        const plan = await ledger.require("plan"),
          deposit = await ledger.require("deposit:confirmed");
        check(
          canonical(plan.config) === canonical(c.basePlan.config) &&
            plan.resource === c.url &&
            plan.perCallAtomic === c.perCallAtomic &&
            plan.depositAtomic === c.depositAtomic &&
            plan.maxCalls === c.maxCalls &&
            plan.deliveryObservationUntil === c.expiresAt,
          "funded_campaign_mismatch",
        );
        check(
          deposit.state === "chain_confirmed" &&
            Number.isSafeInteger(deposit.confirmedAtSeconds),
          "finalized_deposit_required",
        );
        return {
          plan,
          deposit,
          state: (await ledger.require("progress")).state,
        };
      } finally {
        ledger.close();
      }
    };
    const validate = (wire, evidenceId = id) => {
      check(
        feeJournal.get(evidenceId, "router_confirmation"),
        "independent_route_confirmation_required",
      );
      const response = strictJson(wire.bodyText);
      return verifyBatchRoute({
        routeResponseJson: wire.bodyText,
        routeRequestJson: body,
        trustedLogVkey: c.trustedLogVkey,
        challenge: response.batch_binding?.challenge,
      });
    };
    if (
      stage === "route" ||
      stage === "recover-route" ||
      stage === "confirm-route" ||
      second
    ) {
      let outcome;
      if (stage === "route" || stage === "route-after-deposit") {
        if (second) {
          const funding = await fundingEvidence();
          check(
            funding.state === "active:0",
            "unused_finalized_deposit_required",
          );
          const unused = new LocalBatchLedger(join(c.directory, "batch"), id);
          try {
            for (let n = 1; n <= c.maxCalls; n++)
              for (const suffix of ["", ":typed:1", ":unknown", ":accepted"])
                check(
                  !(await unused.get("delivery:" + n + suffix)),
                  "delivery_already_attempted",
                );
          } finally {
            unused.close();
          }
          await control.require("route:verified");
          check(
            feeJournal.get(id, "router_confirmation"),
            "first_fee_unconfirmed",
          );
          if (feeJournal.job(id).state === "reserved")
            feeJournal.finish(id, "complete");
        }
        check(
          await control.once(routePrefix + ":once", {
            feeAtomic: "3000",
            requestDigest: sha(body),
          }),
          "route_already_attempted",
        );
        feeJournal.reserve(
          routeId,
          {
            sellerId: "route-fee-only",
            url: c.url,
            method: "GET",
            bodyText: "",
          },
          "3000",
        );
        await client.prepare(routeId, body);
        const challenge = await client.challenge(routeId);
        const value = await buyer.signRouting(routeId, challenge);
        await client.setPaymentHeader(routeId, { value });
        outcome = await client.submit(routeId);
      } else if (
        stage === "recover-route" ||
        stage === "recover-route-after-deposit"
      )
        outcome = await client.recover(routeId);
      else {
        const rows = await client.evidence(routeId);
        const wire = [...rows]
          .reverse()
          .find(
            (x) =>
              x.response.status === 200 &&
              classifyRouteResponse(x.response).settlementReport === "settled",
          )?.response;
        outcome = {
          response: wire,
          classification: wire ? classifyRouteResponse(wire) : undefined,
        };
      }
      if (
        outcome.response?.status !== 200 ||
        outcome.classification?.settlementReport !== "settled"
      )
        return {
          state: "routing_unresolved_or_unpaid",
          newPaymentAllowed: false,
        };
      if (!(await buyer.confirmRouting(routeId, outcome)))
        return {
          state: "routing_confirmation_unknown",
          newPaymentAllowed: false,
        };
      let binding;
      try {
        binding = validate(outcome.response, routeId);
      } catch (error) {
        if (stage !== "route" && stage !== "route-after-deposit")
          return {
            state: "routing_confirmed_observation_unusable",
            newPaymentAllowed: false,
          };
        throw error;
      }
      if (second) {
        const funding = await fundingEvidence(),
          original = await control.require("route:verified");
        check(
          binding.observed_at >= funding.deposit.confirmedAtSeconds &&
            sha(outcome.response.bodyText) !== original.responseDigest,
          "second_observation_predates_finality",
        );
        check(
          binding.terms.call_amount_atomic === c.perCallAtomic,
          "observed_call_price_changed",
        );
      }
      await control.once(routePrefix + ":verified", {
        responseDigest: sha(outcome.response.bodyText),
        challengeDigest: binding.challenge_sha256,
      });
      if (feeJournal.job(routeId).state === "reserved")
        feeJournal.finish(routeId, "complete");
      return {
        state: "routing_confirmed_and_verified",
        expiresAt: binding.expires_at,
        newPaymentAllowed: false,
      };
    }
    const verified = async (delivery = false) => {
      const useSecond = delivery && c.maxRouteObservations === 2;
      const pin = await control.require(
        useSecond ? "route:after-deposit:verified" : "route:verified",
      );
      const rows = await client.evidence(useSecond ? deliveryRouteId : id),
        wire = rows.find(
          (x) => sha(x.response.bodyText) === pin.responseDigest,
        )?.response;
      check(wire, "private_route_evidence_required");
      const binding = validate(wire, useSecond ? deliveryRouteId : id);
      return { ...binding, ownerProofDigest: pin.responseDigest };
    };
    const { createMerchantSender, createCdpBatchProvider } = await import(
      "./transport.mjs"
    );
    if (c.profile === "solana-mpp-session-v1") {
      check(
        [
          "preflight",
          "open",
          "confirm-open",
          "register",
          "recover-register",
          "recover-delivery-1",
          "recover-delivery-2",
          "recover-delivery-3",
          "deliver-1",
          "deliver-2",
          "deliver-3",
          "close",
          "confirm-close",
          "refund-unused",
        ].includes(stage),
        "native_stage_required",
      );
      check(
        typeof runtime.solanaRpc === "function",
        "native_read_transport_required",
      );
      const readMethods = new Set([
        "getGenesisHash",
        "getAccountInfo",
        "getMultipleAccounts",
        "getTokenAccountBalance",
        "getMinimumBalanceForRentExemption",
        "getFeeForMessage",
        "getBalance",
        "getLatestBlockhash",
        "getTransaction",
        "getSignatureStatuses",
        "getSlot",
      ]);
      const rpc = (method, params) => {
        check(
          readMethods.has(method) ||
            (["open", "close", "refund-unused"].includes(stage) &&
              method === "sendTransaction"),
          "rpc_method_refused",
        );
        return runtime.solanaRpc(method, params);
      };
      const {
        OwnerSessionController,
        prepareSolanaSession,
        verifySolanaSessionDeployment,
      } = await import("../solana-session-contracts/src/owner-session.mjs");
      const operators = await import(
        "../solana-session-contracts/src/owner-operator.mjs"
      );
      batchLedger = new LocalBatchLedger(join(c.directory, "batch"), id);
      let plan = await batchLedger.get("plan");
      if (!plan) {
        check(["preflight", "open"].includes(stage), "native_plan_required");
        const binding = await verified();
        const prepared = await prepareSolanaSession({
          wwwAuthenticate: binding.challenge.wwwAuthenticate,
          request: {
            url: c.url,
            method: "GET",
            digest: sha(
              JSON.stringify({ url: c.url, method: "GET", body: "" }),
            ),
          },
          policy: c.nativePolicy,
        });
        const { intentDigest, ...parts } = structuredClone(prepared);
        parts.observedAt = binding.observed_at * 1000;
        parts.expiresAt = Math.min(
          parts.expiresAt,
          binding.expires_at * 1000,
          c.expiresAt,
        );
        plan = { ...parts, intentDigest: sha(JSON.stringify(parts)) };
      }
      const controller = new OwnerSessionController(batchLedger, plan);
      await controller.initialize();
      const sender = createMerchantSender(c.url, {
        fetch: runtime.fetch,
        native: true,
      });
      let result;
      if (stage === "preflight") {
        await verified();
        result = await verifySolanaSessionDeployment(rpc, plan);
      }
      if (stage === "open") {
        await verified();
        await controller.signOpen(runtime.nativeBuyer, rpc);
        result = await controller.sendOpen((credential) =>
          operators.openSessionLocally({
            ledger: batchLedger,
            plan,
            credential,
            operator: runtime.nativeOperator,
            rpc,
          }),
        );
      }
      if (stage === "confirm-open")
        result = await controller.confirmOpen(
          rpc,
          (await batchLedger.get("operator:open:signed"))?.signature,
        );
      if (stage === "register")
        result = await operators.registerOpenedSession({
          ledger: batchLedger,
          send: sender,
        });
      if (
        stage === "recover-register" ||
        stage.startsWith("recover-delivery-")
      ) {
        const { createMerchantRecovery } = await import(
          "./merchant-recovery.mjs"
        );
        const recover = createMerchantRecovery(c.url, {
          fetch: runtime.fetch,
          native: true,
        });
        if (stage === "recover-register")
          result = await operators.recoverOpenedSession({
            ledger: batchLedger,
            plan,
            recover,
          });
        else {
          const sequence = Number(stage.slice(-1));
          check(sequence <= c.maxCalls, "delivery_count_exceeded");
          result = await controller.recoverVoucher(sequence, recover);
        }
      }
      if (stage.startsWith("deliver-")) {
        const n = Number(stage.slice(-1));
        check(n <= c.maxCalls, "delivery_count_exceeded");
        await verified();
        await batchLedger.require("merchant:open:response");
        result = await controller.voucher(
          runtime.nativeBuyer,
          n,
          c.perCallAtomic,
          sender,
        );
      }
      if (stage === "close") {
        const state = (await batchLedger.require("progress")).state;
        check(/^active:[1-3]$/.test(state), "known_delivery_required");
        const sequence = Number(state.split(":")[1]);
        result = await controller.close(sequence, (credential) =>
          operators.closeSessionLocally({
            ledger: batchLedger,
            plan,
            credential,
            operator: runtime.nativeOperator,
            rpc,
            maximumCloseFeeLamports: c.maximumCloseFeeLamports,
          }),
        );
      }
      if (stage === "refund-unused")
        result = await operators.closeUnspentSessionLocally({
          ledger: batchLedger,
          plan,
          operator: runtime.nativeOperator,
          rpc,
          maximumCloseFeeLamports: c.maximumCloseFeeLamports,
        });
      if (stage === "confirm-close")
        result = await controller.confirmClose(
          rpc,
          (await batchLedger.require("operator:close:signed")).signature,
        );
      return {
        state: safeState(result, "stage_recorded"),
        privateEvidenceRetained: true,
        newPaymentAllowed: false,
      };
    }
    check(
      [
        "preflight",
        "deposit",
        "confirm-deposit",
        "recover-delivery-1",
        "recover-delivery-2",
        "recover-delivery-3",
        "close-empty",
        "deliver-1",
        "deliver-2",
        "deliver-3",
        "close",
        "claim",
        "confirm-claim",
        "settle",
        "confirm-settle",
        "refund",
        "confirm-refund",
        "refund-unused",
      ].includes(stage),
      "base_stage_required",
    );
    const { createLocalBaseCampaign } = await import("./base-owner.mjs");
    let boundPlan;
    const priorLedger = new LocalBatchLedger(join(c.directory, "batch"), id);
    try {
      boundPlan = await priorLedger.get("plan");
    } finally {
      priorLedger.close();
    }
    if (!boundPlan) {
      check(["preflight", "deposit"].includes(stage), "base_plan_required");
      const binding = await verified();
      boundPlan = {
        ...c.basePlan,
        expiresAt: Math.min(c.expiresAt, binding.expires_at * 1000),
        ...(c.maxRouteObservations === 2
          ? { deliveryObservationUntil: c.expiresAt }
          : {}),
      };
    }
    const campaign = await createLocalBaseCampaign({
      directory: join(c.directory, "batch"),
      campaignId: id,
      plan: boundPlan,
      rpc: runtime.baseRpc,
    });
    batchLedger = campaign.ledger;
    const controller = campaign.controller;
    let result;
    if (
      ["preflight", "deposit"].includes(stage) ||
      stage.startsWith("deliver-")
    ) {
      const delivery = stage.startsWith("deliver-");
      const binding = await verified(delivery);
      check(
        binding.terms.call_amount_atomic === c.perCallAtomic,
        "observed_call_price_changed",
      );
      if (delivery && c.maxRouteObservations === 2) {
        const { computeChannelId } = await import(
          (await import("node:module"))
            .createRequire(new URL("../package.json", import.meta.url))
            .resolve("@x402/evm/batch-settlement/client")
        );
        const { digest } = await import("../dist/src/base-batch-ledger.js");
        const funding = await fundingEvidence();
        await controller.bindDeliveryObservation({
          proofDigest: binding.ownerProofDigest,
          channelId: computeChannelId(boundPlan.config, "eip155:8453"),
          termsDigest: digest({
            resource: boundPlan.resource,
            config: boundPlan.config,
            perCallAtomic: boundPlan.perCallAtomic,
            depositAtomic: boundPlan.depositAtomic,
            maxCalls: boundPlan.maxCalls,
          }),
          observedAt: binding.observed_at * 1000,
          expiresAt: Math.min(binding.expires_at * 1000, c.expiresAt),
          depositTransactionHash: funding.deposit.transactionHash,
        });
      }
    }
    const provider = () =>
      createCdpBatchProvider({
        authorization: runtime.cdpAuthorization,
        fetch: runtime.fetch,
      });
    if (stage === "preflight") {
      const supported = await provider().getSupported();
      check(
        supported.kinds?.some(
          (k) =>
            k.x402Version === 2 &&
            k.network === "eip155:8453" &&
            k.scheme === "batch-settlement",
        ),
        "provider_batch_unavailable",
      );
      result = { state: "ready" };
    }
    if (stage === "deposit") {
      await controller.prepareDeposit(runtime.baseOwner);
      result = await controller.sendDeposit(provider());
    }
    if (stage.startsWith("confirm-"))
      result = await controller.confirm(stage.slice(8), reference);
    if (stage.startsWith("deliver-")) {
      const n = Number(stage.slice(-1));
      check(n <= c.maxCalls, "delivery_count_exceeded");
      result = await controller.deliver(
        runtime.baseOwner,
        n,
        sha(JSON.stringify({ url: c.url, method: "GET", body: "" })),
        createMerchantSender(c.url, { fetch: runtime.fetch }),
      );
    }
    if (stage.startsWith("recover-delivery-")) {
      const sequence = Number(stage.slice(-1));
      check(sequence <= c.maxCalls, "delivery_count_exceeded");
      const { createMerchantRecovery } = await import(
        "./merchant-recovery.mjs"
      );
      result = await controller.recoverDelivery(
        sequence,
        createMerchantRecovery(c.url, { fetch: runtime.fetch }),
      );
    }
    if (stage === "close-empty") {
      await controller.closeEmpty();
      result = { state: "closed" };
    }
    if (stage === "close") {
      const state = (await batchLedger.require("progress")).state;
      check(/^active:[1-3]$/.test(state), "known_delivery_required");
      await controller.close(Number(state.split(":")[1]));
      result = { state: "closing" };
    }
    if (stage === "claim" || stage === "settle")
      result = await controller.sendCloseOperation(stage, provider());
    if (stage === "refund") result = await controller.sendRefund(provider());
    if (stage === "refund-unused")
      result = await controller.sendUnspentRefund(provider());
    return {
      state: safeState(result, "stage_recorded"),
      privateEvidenceRetained: true,
      newPaymentAllowed: false,
    };
  } finally {
    batchLedger?.close();
    feeJournal?.close();
    control.close();
  }
}
async function newState(c) {
  const ledger = new LocalBatchLedger(join(c.directory, "batch"), c.campaignId);
  try {
    return await ledger.get("progress");
  } finally {
    ledger.close();
  }
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const [stage = "plan", configPath, factoryPath, reference] = argv;
  check(argv.length <= 4, "argument_bound");
  check(configPath, "configuration_required");
  const config = strictJson(readFileSync(resolve(configPath), "utf8"));
  const result = await runCampaign({
    stage,
    config,
    factoryPath,
    reference,
    env,
  });
  console.log(JSON.stringify(result));
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error(
      JSON.stringify({
        state: "stopped",
        code: "operation_stopped",
        newPaymentAllowed: false,
        privateEvidenceRetained: true,
      }),
    );
    process.exitCode = 1;
  });
