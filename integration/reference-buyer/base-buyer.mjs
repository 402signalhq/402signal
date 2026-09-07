import { reconcilePayment } from "@402signal/route-guard/recovery";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { verifyTypedData } from "viem";
import {
  withVerifiedRoute,
  isUnsettledRouteMiss,
} from "@402signal/route-guard";
import {
  BASE,
  USDC,
  check,
  canonical,
  digest,
  atomic,
  address,
  https,
  decode64,
  challengeOf,
  terms,
  checkTypedData,
  jsonSafe,
  strictJson,
} from "./policy.mjs";
import { confirmBase, readResponse, readOnlyRpc } from "./confirmation.mjs";
export async function sdkPayload({ challenge, account }) {
  const c = new x402Client();
  c.register(BASE, new ExactEvmScheme(account));
  return c.createPaymentPayload({
    x402Version: 2,
    resource: challenge.resource,
    accepts: [challenge.accepts[0]],
  });
}
/** Existing buyer-owned signer only. No private key, custody or global Fetch setup. */
export class BaseBuyer {
  #account;
  #journal;
  #policy;
  #fetch;
  #rpc;
  #now;
  #factory;
  #sellerFactory;
  #sellerTiming;
  constructor({
    account,
    journal,
    policy,
    fetch: fetchImpl = globalThis.fetch,
    rpc,
    now = () => Math.floor(Date.now() / 1000),
    createPayload = sdkPayload,
    createSellerPayload,
    sellerAuthorizationTiming = "zero",
  }) {
    check(
      account && typeof account.signTypedData === "function",
      "buyer_account_required",
    );
    address(account.address);
    https(policy.routerUrl);
    https(policy.rpcUrl);
    address(policy.routerPayTo);
    atomic(policy.campaignMaximumAtomic);
    check(
      policy.buyerNativeFeeAtomic === "0" &&
        Array.isArray(policy.sellers) &&
        policy.sellers.length > 0 &&
        policy.sellers.length <= 4,
      "invalid_buyer_policy",
    );
    for (const s of policy.sellers) {
      https(s.url);
      address(s.payTo);
      check(
        atomic(s.maximumAtomic) > 0n &&
          Number.isSafeInteger(s.maxLifetimeSeconds) &&
          s.maxLifetimeSeconds > 0 &&
          s.maxLifetimeSeconds <= 300,
        "invalid_seller_policy",
      );
    }
    check(
      address(policy.buyerAddress) === address(account.address),
      "buyer_address_mismatch",
    );
    this.#account = account;
    this.#journal = journal;
    this.#policy = structuredClone(policy);
    this.#fetch = fetchImpl;
    this.#rpc = rpc ?? readOnlyRpc(policy.rpcUrl, fetchImpl);
    this.#now = now;
    this.#factory = createPayload;
    this.#sellerFactory = createSellerPayload;
    check(
      ["zero", "recent"].includes(sellerAuthorizationTiming),
      "invalid_authorization_timing",
    );
    this.#sellerTiming = sellerAuthorizationTiming;
  }
  reserve(id, request) {
    https(request.url);
    check(
      ["GET", "POST"].includes(request.method) &&
        typeof request.bodyText === "string" &&
        Buffer.byteLength(request.bodyText) <= 4096,
      "invalid_request",
    );
    if (request.method === "GET")
      check(request.bodyText === "", "get_body_refused");
    else {
      const body = strictJson(request.bodyText, 4096);
      check(
        request.sellerId === "parallel" &&
          request.url === "https://parallelmpp.dev/api/search" &&
          Object.keys(body).sort().join(",") === "mode,query" &&
          body.mode === "one-shot" &&
          typeof body.query === "string" &&
          body.query.trim().length > 0 &&
          body.query.length <= 300,
        "post_profile_refused",
      );
    }
    const seller = this.#policy.sellers.find((s) => s.id === request.sellerId);
    check(
      seller &&
        request.url.split("?")[0] === seller.url &&
        request.method === seller.method,
      "seller_request_refused",
    );
    this.#journal.reserve(
      id,
      { ...request, bodySha256: digest(request.bodyText) },
      (3000n + atomic(seller.maximumAtomic)).toString(),
    );
  }
  async #sign(id, stage, challenge, expected) {
    const job = this.#journal.job(id);
    check(job.state === "reserved", "job_finished");
    const q = terms(challenge, expected, this.#account.address, this.#now());
    check((await this.#rpc("eth_chainId", [])) === "0x2105", "wrong_rpc_chain");
    const balance = await this.#rpc("eth_call", [
      {
        to: USDC,
        data:
          "0x70a08231" +
          this.#account.address.slice(2).toLowerCase().padStart(64, "0"),
      },
      "latest",
    ]);
    check(
      typeof balance === "string" &&
        /^0x[0-9a-fA-F]+$/.test(balance) &&
        BigInt(balance) >= BigInt(stage === "router" ? job.reserved : q.amount),
      "insufficient_usdc_balance",
    );
    this.#journal.put(id, stage + "_sign_claim", {
      terms: q,
      challengeSha256: digest(challenge),
    });
    let calls = 0,
      intent;
    const account = {
      address: this.#account.address,
      signTypedData: async (data) => {
        check(++calls === 1, "signing_retry_refused");
        intent = checkTypedData(
          data,
          q,
          this.#account.address,
          this.#now(),
          stage === "seller" ? this.#sellerTiming : "zero",
        );
        this.#journal.put(id, stage + "_intent", {
          ...intent,
          request: job.request,
        });
        this.#journal.put(id, stage + "_typed_data", jsonSafe(data));
        return this.#account.signTypedData(data);
      },
    };
    const factory =
      stage === "seller" && this.#sellerFactory
        ? this.#sellerFactory
        : this.#factory;
    const payload = await factory({
      challenge: structuredClone(challenge),
      account,
      request: job.request,
    });
    check(calls === 1 && intent, "signer_not_called_once");
    check(
      payload.x402Version === 2 &&
        canonical(payload.accepted) === canonical(q) &&
        canonical(payload.resource) === canonical(challenge.resource),
      "signed_payload_mismatch",
    );
    check(
      Object.keys(payload).every((k) =>
        [
          "x402Version",
          "accepted",
          "resource",
          "payload",
          "extensions",
        ].includes(k),
      ) &&
        Object.keys(payload.payload ?? {})
          .sort()
          .join(",") === "authorization,signature" &&
        (payload.extensions === undefined ||
          canonical(payload.extensions) === canonical(challenge.extensions)),
      "unknown_payload_authority",
    );
    const auth = payload.payload?.authorization;
    const data = this.#journal.get(id, stage + "_typed_data");
    check(
      auth &&
        canonical(auth) ===
          canonical({
            // Retain the exact signed address representation after the guard
            // has checked its economic identity against the original offer.
            from: data.message.from,
            to: data.message.to,
            value: intent.amount,
            validAfter: intent.validAfter,
            validBefore: intent.validBefore,
            nonce: intent.nonce,
          }),
      "authorization_payload_mismatch",
    );
    check(
      await verifyTypedData({
        ...data,
        address: this.#account.address,
        signature: payload.payload.signature,
      }),
      "signature_verification_failed",
    );
    const value = Buffer.from(JSON.stringify(payload)).toString("base64");
    this.#journal.put(id, stage + "_authorization", { value, payload });
    return value;
  }
  async signRouting(id, wire) {
    check(!this.#journal.get(id, "router_sign_claim"), "stage_already_claimed");
    const original = challengeOf(wire, { router: true });
    check(
      original.resource?.url === this.#policy.routerUrl &&
        (!original.extensions ||
          Object.keys(original.extensions).every((k) => k === "bazaar")),
      "router_challenge_scope_refused",
    );
    const options = original.accepts.filter((x) => x.network === BASE);
    check(options.length === 1, "ambiguous_base_offer");
    this.#journal.put(id, "router_challenge", {
      bodyText: wire.bodyText,
      paymentRequired: wire.paymentRequired ?? null,
      selectedIndex: original.accepts.indexOf(options[0]),
    });
    return this.#sign(
      id,
      "router",
      { ...original, accepts: [options[0]] },
      {
        router: true,
        payTo: this.#policy.routerPayTo,
        maximumAtomic: "3000",
        exactAtomic: "3000",
        maxLifetimeSeconds: 60,
      },
    );
  }
  validatedFreeMiss(id, outcome) {
    if (!outcome.response) return false;
    const r = outcome.response;
    if (
      !isUnsettledRouteMiss({
        httpStatus: r.status,
        routeResponseJson: r.bodyText,
        paymentResponseHeader: r.paymentResponse,
      })
    )
      return false;
    this.#journal.put(id, "router_free_miss", { response: r });
    this.#journal.finish(id, "free_miss");
    return true;
  }
  async confirmRouting(id, outcome) {
    check(
      outcome.response?.status === 200 &&
        outcome.classification?.settlementReport === "settled",
      "routing_not_settled",
    );
    return this.#confirm(id, "router", outcome.response.paymentResponse);
  }
  async #observe(intent, transaction) {
    const r = await reconcilePayment({
      rail: "base",
      transaction,
      maxObservations: 3,
      intervalMs: 500,
      timeoutMs: 15000,
      observe: ({ signal }) =>
        confirmBase(intent, transaction, (m, p) => this.#rpc(m, p, signal)),
    });
    return r.confirmation ?? { state: "unknown", transaction };
  }
  async #confirm(id, stage, header) {
    const intent = this.#journal.get(id, stage + "_intent");
    check(intent, "missing_payment_intent");
    let receipt;
    try {
      receipt = decode64(header);
      check(
        receipt.success === true &&
          receipt.network === BASE &&
          (receipt.payer === undefined ||
            address(receipt.payer) === address(this.#account.address)) &&
          (receipt.amount === undefined || receipt.amount === intent.amount),
        "receipt_scope_mismatch",
      );
    } catch {
      return false;
    }
    const observed = await this.#observe(intent, receipt.transaction);
    if (observed.state !== "confirmed") return false;
    if (!this.#journal.get(id, stage + "_confirmation"))
      this.#journal.put(id, stage + "_confirmation", observed);
    return true;
  }
  async executeSellerOnce(
    id,
    { outcome, routeRequestJson, trustedLogVkey, challenge },
  ) {
    const job = this.#journal.job(id);
    check(
      this.#journal.get(id, "router_confirmation") &&
        outcome.response?.status === 200,
      "routing_confirmation_required",
    );
    const request = job.request;
    const seller = this.#policy.sellers.find((s) => s.id === request.sellerId);
    const c = challengeOf(challenge);
    let result;
    await withVerifiedRoute(
      {
        routeResponseJson: outcome.response.bodyText,
        routeRequestJson,
        trustedLogVkey,
        request: {
          url: request.url,
          method: request.method,
          body: Buffer.from(request.bodyText),
        },
        challenge,
        now: this.#now(),
      },
      async (action) => {
        check(
          canonical(action.accepted) === canonical(c.accepts[0]),
          "seller_terms_changed",
        );
        const q = terms(c, seller, this.#account.address, this.#now());
        this.#journal.put(id, "seller_route_verified", {
          quoteSha256: action.quote_sha256,
          request,
          accepted: q,
        });
        const value = await this.#sign(id, "seller", c, seller);
        this.#journal.put(id, "seller_submission", {
          request,
          authorizationSha256: digest(value),
        });
        const res = await this.#fetch(request.url, {
          method: request.method,
          body: request.method === "POST" ? request.bodyText : undefined,
          headers: {
            ...(request.method === "POST"
              ? { "Content-Type": "application/json" }
              : {}),
            "PAYMENT-SIGNATURE": value,
          },
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        });
        check(!res.redirected, "seller_redirect_refused");
        const wire = {
          status: res.status,
          bodyText: await readResponse(res),
          paymentResponse: res.headers.get("PAYMENT-RESPONSE"),
        };
        this.#journal.put(id, "seller_response", wire);
        const confirmed =
          res.status === 200 &&
          (await this.#confirm(id, "seller", wire.paymentResponse));
        if (confirmed) this.#journal.finish(id, "complete");
        result = {
          state: confirmed
            ? "payment_confirmed_response_received"
            : "seller_outcome_unresolved",
          response: wire,
          deliveryQuality: "not_assessed",
        };
      },
    );
    return result;
  }
  async reconcileSeller(id, transaction) {
    const intent = this.#journal.get(id, "seller_intent");
    check(
      intent && this.#journal.get(id, "seller_submission"),
      "seller_not_submitted",
    );
    let confirmed;
    if (transaction) {
      const observation = await this.#observe(intent, transaction);
      confirmed = observation.state === "confirmed";
      if (confirmed && !this.#journal.get(id, "seller_confirmation"))
        this.#journal.put(id, "seller_confirmation", observation);
    } else {
      confirmed = await this.#confirm(
        id,
        "seller",
        this.#journal.get(id, "seller_response")?.paymentResponse,
      );
    }
    if (confirmed && this.#journal.job(id).state === "reserved")
      this.#journal.finish(id, "complete");
    return {
      state: confirmed ? "payment_confirmed" : "confirmation_unknown",
      deliveryQuality: "not_assessed",
      responseRetained: !!this.#journal.get(id, "seller_response"),
    };
  }
  async sellerChallenge(id) {
    const r = this.#journal.job(id).request;
    check(
      this.#journal.get(id, "router_confirmation"),
      "routing_confirmation_required",
    );
    const res = await this.#fetch(r.url, {
      method: r.method,
      body: r.method === "POST" ? r.bodyText : undefined,
      headers:
        r.method === "POST" ? { "Content-Type": "application/json" } : {},
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    check(!res.redirected, "seller_redirect_refused");
    return {
      status: res.status,
      bodyText: await readResponse(res, 262144),
      paymentRequired: res.headers.get("PAYMENT-REQUIRED") ?? undefined,
      xPaymentRequired: res.headers.get("X-PAYMENT-REQUIRED") ?? undefined,
    };
  }
}
