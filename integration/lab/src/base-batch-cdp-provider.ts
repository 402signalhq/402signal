import {
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  constants,
} from "node:fs";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";
import { assert, parseJson } from "./json.js";
const ROOT = "https://api.cdp.coinbase.com/platform/v2/x402";
export const CDP_BATCH_AUTHORIZER =
  "0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
function keys(value: any, expected: string[]) {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === expected.sort().join(","),
    "batch_provider_credentials_unavailable",
    503,
  );
}
function jwt(raw: unknown, kind: "supported" | "verify", now: number) {
  assert(
    typeof raw === "string" && raw.length <= 8192,
    "batch_provider_credentials_unavailable",
    503,
  );
  const parts = raw.split(".");
  assert(parts.length === 3, "batch_provider_credentials_unavailable", 503);
  const decoded = parts.map((x) => {
    assert(
      /^[A-Za-z0-9_-]+$/.test(x),
      "batch_provider_credentials_unavailable",
      503,
    );
    const b = Buffer.from(x, "base64url");
    assert(
      b.toString("base64url") === x,
      "batch_provider_credentials_unavailable",
      503,
    );
    return b;
  });
  const header = parseJson(decoded[0]!.toString("utf8")),
    claims = parseJson(decoded[1]!.toString("utf8"));
  keys(header, ["alg", "typ", "kid", "nonce"]);
  keys(claims, ["sub", "iss", "aud", "nbf", "exp", "uri"]);
  assert(
    ["EdDSA", "ES256"].includes(header.alg) &&
      header.typ === "JWT" &&
      typeof header.kid === "string" &&
      header.kid.length > 0 &&
      header.kid.length <= 256 &&
      /^[0-9a-f]{32}$/.test(header.nonce) &&
      decoded[2]!.length === 64,
    "batch_provider_credentials_unavailable",
    503,
  );
  assert(
    claims.sub === header.kid &&
      claims.iss === "cdp" &&
      Array.isArray(claims.aud) &&
      claims.aud.length === 1 &&
      claims.aud[0] === "cdp_service" &&
      claims.uri ===
        (kind === "supported" ? "GET" : "POST") +
          " api.cdp.coinbase.com/platform/v2/x402/" +
          kind &&
      Number.isSafeInteger(claims.nbf) &&
      Number.isSafeInteger(claims.exp) &&
      claims.nbf <= now &&
      claims.nbf >= now - 120 &&
      claims.exp > now + 5 &&
      claims.exp > claims.nbf &&
      claims.exp - claims.nbf <= 120,
    "batch_provider_credentials_unavailable",
    503,
  );
  // Local claim checks constrain accidental token routing. CDP verifies its signature.
  return raw;
}
/** Separate short-lived tokens; no API master key, wallet key, renewal or onchain
 * settlement capability in the cloud merchant. Each call rereads the owner file. */
export class CdpBatchReadOnlyProvider implements FacilitatorClient {
  constructor(
    private tokenFile: string,
    private campaignId: string,
    private send: typeof fetch = fetch,
  ) {
    assert(
      typeof tokenFile === "string" &&
        tokenFile.length > 0 &&
        /^[A-Za-z0-9_-]{8,80}$/.test(campaignId),
      "batch_provider_config_required",
      503,
    );
  }
  private token(kind: "supported" | "verify") {
    let fd: number | undefined;
    try {
      fd = openSync(this.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      assert(
        st.isFile() &&
          st.nlink === 1 &&
          st.size > 0 &&
          st.size <= 20000 &&
          (st.mode & 0o077) === 0 &&
          typeof process.getuid === "function" &&
          st.uid === process.getuid(),
        "batch_provider_credentials_unavailable",
        503,
      );
      const raw = readFileSync(fd, "utf8");
      assert(
        Buffer.byteLength(raw) <= 20000,
        "batch_provider_credentials_unavailable",
        503,
      );
      const file = parseJson(raw);
      keys(file, ["version", "campaignId", "supportedJwt", "verifyJwt"]);
      assert(
        file.version === 1 &&
          file.campaignId === this.campaignId &&
          typeof file.supportedJwt === "string" &&
          typeof file.verifyJwt === "string" &&
          file.supportedJwt.length <= 8192 &&
          file.verifyJwt.length <= 8192,
        "batch_provider_credentials_unavailable",
        503,
      );
      return jwt(
        kind === "supported" ? file.supportedJwt : file.verifyJwt,
        kind,
        Math.floor(Date.now() / 1000),
      );
    } catch {
      throw new Error("batch_provider_credentials_unavailable");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private async call(
    kind: "supported" | "verify",
    body?: unknown,
  ): Promise<any> {
    const token = this.token(kind),
      url = ROOT + "/" + kind;
    try {
      const response = await this.send(url, {
        method: kind === "supported" ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      assert(
        !response.redirected &&
          (!response.url || response.url === url) &&
          response.status === 200,
        "batch_provider_unavailable",
        503,
      );
      const length = response.headers.get("content-length");
      assert(
        length === null ||
          (/^[0-9]+$/.test(length) && Number(length) <= 262144),
        "batch_provider_unavailable",
        503,
      );
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader)
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.length;
            assert(size <= 262144, "batch_provider_unavailable", 503);
            chunks.push(item.value);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        }
      return parseJson(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        262144,
      );
    } catch {
      throw new Error("batch_provider_unavailable");
    }
  }
  async getSupported(): Promise<SupportedResponse> {
    const value = await this.call("supported");
    assert(
      Array.isArray(value.kinds) &&
        value.kinds.length <= 128 &&
        Array.isArray(value.extensions) &&
        value.extensions.length <= 128,
      "batch_provider_supported_invalid",
      503,
    );
    const matched = value.kinds.filter(
      (k: any) =>
        k.x402Version === 2 &&
        k.scheme === "batch-settlement" &&
        k.network === "eip155:8453",
    );
    assert(
      matched.length === 1 &&
        typeof matched[0].extra?.receiverAuthorizer === "string" &&
        matched[0].extra.receiverAuthorizer.toLowerCase() ===
          CDP_BATCH_AUTHORIZER.toLowerCase(),
      "batch_provider_supported_invalid",
      503,
    );
    return value;
  }
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    assert(
      paymentPayload.x402Version === 2 &&
        (paymentPayload.payload as any)?.type === "voucher" &&
        paymentRequirements.scheme === "batch-settlement" &&
        paymentRequirements.network === "eip155:8453" &&
        paymentRequirements.asset.toLowerCase() === USDC.toLowerCase() &&
        String(paymentRequirements.extra?.receiverAuthorizer).toLowerCase() ===
          CDP_BATCH_AUTHORIZER.toLowerCase(),
      "batch_provider_voucher_only",
      503,
    );
    const value = await this.call("verify", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
    assert(
      typeof value?.isValid === "boolean",
      "batch_provider_verification_invalid",
      503,
    );
    return value;
  }
  async settle(
    _paymentPayload: PaymentPayload,
    _paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    throw new Error("cloud_batch_settlement_disabled");
  }
}
