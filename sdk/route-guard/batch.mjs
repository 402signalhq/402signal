import { parse as parseJson, Fraction } from "./internal-json.mjs";
/** Local evidence/quote guard. Keys, networking and economic actions stay external. */
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

const TYPE = "402signal.route_decision.v5";
const MODEL = "proof_carrying_batch_observation_v1";
const HEX = /^[0-9a-f]{64}$/;
const LIMIT = 64 * 1024;
const sha = (...buffers) =>
  createHash("sha256")
    .update(Buffer.concat(buffers.map((b) => Buffer.from(b))))
    .digest();

export class RouteGuardError extends Error {
  constructor(code) {
    super(code);
    this.name = "RouteGuardError";
    this.code = code;
  }
}
const fail = (code = "invalid_binding") => {
  throw new RouteGuardError(code);
};

const parse = (raw, options = {}) => parseJson(raw, { ...options, fail });

function canonical(value, ordinaryNumbers = false, depth = 0) {
  if (depth > 24) fail("invalid_json");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (ordinaryNumbers || Number.isSafeInteger(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return (
      "[" +
      value.map((v) => canonical(v, ordinaryNumbers, depth + 1)).join(",") +
      "]"
    );
  if (
    value &&
    (Object.getPrototypeOf(value) === null ||
      Object.getPrototypeOf(value) === Object.prototype)
  ) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical(value[k], ordinaryNumbers, depth + 1),
        )
        .join(",") +
      "}"
    );
  }
  fail("invalid_json");
}
const exactKeys = (obj, keys) => {
  if (
    !obj ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    Object.keys(obj).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(obj, k))
  )
    fail();
};
const decode64 = (s, size) => {
  if (
    typeof s !== "string" ||
    s.length > LIMIT ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(s)
  )
    fail("invalid_encoding");
  const b = Buffer.from(s, "base64");
  if (b.toString("base64") !== s || (size !== undefined && b.length !== size))
    fail("invalid_encoding");
  return b;
};
const hex32 = (s) => {
  if (typeof s !== "string" || !HEX.test(s)) fail();
  return Buffer.from(s, "hex");
};

/** Independently pinned key only. A key offered in the same response is never the pin. */
function pinnedLogVkey(vkey) {
  if (typeof vkey !== "string" || !vkey.trim()) fail("untrusted_receipt");
  return vkey.trim();
}

function authenticate(tr, vkey) {
  vkey = pinnedLogVkey(vkey);
  const keyParts = /^([^+\s]+)\+([0-9a-f]{8})\+(.+)$/.exec(vkey);
  if (!keyParts) fail("untrusted_receipt");
  const [, origin, kidHex, key64] = keyParts;
  const key = decode64(key64, 33);
  if (
    key[0] !== 1 ||
    sha(origin + "\n", key)
      .subarray(0, 4)
      .toString("hex") !== kidHex
  )
    fail("untrusted_receipt");
  const { receipt, reveal } = tr;
  exactKeys(reveal, [
    "type",
    "event_version",
    "ts",
    "nonce",
    "commitment",
    "evidence",
    "salt",
  ]);
  if (reveal.type !== TYPE || reveal.event_version !== TYPE)
    fail("unsupported_receipt");
  exactKeys(reveal.evidence, [
    "evidence_version",
    "request_json",
    "batch_binding",
  ]);
  if (reveal.evidence.evidence_version !== 3) fail("unsupported_receipt");
  const committed = sha(
    TYPE + "\0",
    canonical(reveal.evidence),
    hex32(reveal.salt),
  );
  if (!committed.equals(hex32(reveal.commitment))) fail("commitment_mismatch");
  hex32(reveal.nonce);
  if (
    typeof reveal.ts !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/.test(reveal.ts)
  )
    fail();
  const leaf = sha(
    Buffer.from([0]),
    canonical({
      type: TYPE,
      ts: reveal.ts,
      nonce: reveal.nonce,
      commitment: reveal.commitment,
    }),
  );
  if (!leaf.equals(hex32(receipt.leaf_hash))) fail("leaf_mismatch");
  if (
    typeof receipt.checkpoint !== "string" ||
    receipt.checkpoint.length > LIMIT
  )
    fail("invalid_checkpoint");
  // v1 accepts the exact checkpoint shape issued by 402Signal, no extensions.
  const note =
    /^([^\n]+)\n([1-9][0-9]*)\n([^\n]+)\n\n— ([^\s]+) ([^\s]+)\n$/.exec(
      receipt.checkpoint,
    );
  if (!note || note[1] !== origin || note[4] !== origin)
    fail("untrusted_origin");
  const size = Number(note[2]);
  if (!Number.isSafeInteger(size)) fail("invalid_checkpoint");
  const root = decode64(note[3], 32),
    sig = decode64(note[5], 68);
  if (sig.subarray(0, 4).toString("hex") !== kidHex) fail("untrusted_receipt");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(1),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !verifySignature(
      null,
      Buffer.from(`${origin}\n${note[2]}\n${note[3]}\n`),
      publicKey,
      sig.subarray(4),
    )
  )
    fail("signature_mismatch");
  const index = receipt.index;
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= size ||
    !Array.isArray(receipt.inclusion_path) ||
    receipt.inclusion_path.length > 53
  )
    fail("invalid_inclusion");
  const path = receipt.inclusion_path.map((p) => decode64(p, 32));
  const fold = (m, n) => {
    if (n === 1) {
      if (path.length) fail("invalid_inclusion");
      return leaf;
    }
    let k = 1;
    while (k * 2 < n) k *= 2;
    if (!path.length) fail("invalid_inclusion");
    const sibling = path.pop();
    return m < k
      ? sha(Buffer.from([1]), fold(m, k), sibling)
      : sha(Buffer.from([1]), sibling, fold(m - k, n - k));
  };
  if (!fold(index, size).equals(root)) fail("invalid_inclusion");
  return reveal.evidence;
}

import { validateBaseBatchProfile } from "./batch-profiles/base.mjs";
import { validateSolanaSessionProfile } from "./batch-profiles/solana.mjs";
import { validateAlgorandBatchProfile } from "./batch-profiles/algorand.mjs";
import { validateAlgorandGenericProfile } from "./batch-profiles/algorand-generic.mjs";
import { validateAlgorandAtomicMultiProfile, validateAlgorandInvoiceProfile, ATOMIC as ALGO_MULTI, INVOICE as ALGO_INVOICE } from "./batch-profiles/algorand-manifest.mjs";
import {validateBaseChargeProfile} from "./batch-profiles/base-charge.mjs";
import {nativeChargeChallenges, nativeChargeWire} from "./batch-profiles/native-charge.mjs";
import {validateAlgorandChargeProfile} from "./batch-profiles/algorand-charge.mjs";
const JOB = "chk_grp";
const LABEL = "Check group offer";
const CODECS = ["exact", "sess", "mpp", "atom", "inv"];
const PROFILE_CODEC = {
  "base-x402-batch-v1": "exact",
  "solana-mpp-session-v1": "sess",
  "base-mpp-charge-v1": "mpp",
  "algorand-mpp-charge-v1": "mpp",
  "algorand-atomic-batch-v1": "atom",
  "algorand-atomic-two-item-v1": "atom",
  [ALGO_MULTI]: "atom",
  [ALGO_INVOICE]: "inv",
};
const EXTENSION = "402signal-atomic-batch";
const PROFILES = {
  "algorand-mpp-charge-v1": validateAlgorandChargeProfile,
  "base-mpp-charge-v1": validateBaseChargeProfile,
  "base-x402-batch-v1": validateBaseBatchProfile,
  "solana-mpp-session-v1": validateSolanaSessionProfile,
  "algorand-atomic-batch-v1": validateAlgorandBatchProfile,
  "algorand-atomic-two-item-v1": validateAlgorandGenericProfile,
  [ALGO_MULTI]: validateAlgorandAtomicMultiProfile,
  [ALGO_INVOICE]: validateAlgorandInvoiceProfile,
};
const check = (x) => {
  if (!x) fail("invalid_batch_binding");
};
function context(url) {
  check(
    typeof url === "string" &&
      url.length <= 4096 &&
      /^[\x21-\x7e]+$/.test(url) &&
      !/[\\#]/.test(url),
  );
  const u = new URL(url);
  check(
    u.protocol === "https:" &&
      u.hostname &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.port,
  );
  return { url, method: "GET", body_sha256: sha("").toString("hex") };
}
function request(body) {
  check(
    body &&
      Object.keys(body).every((k) =>
        [
          "url",
          "merchant_profile",
          "buyer_limits",
          "require_route_binding",
          "lab_test",
        ].includes(k),
      ) &&
      body.require_route_binding === true &&
      body.buyer_limits &&
      typeof body.buyer_limits === "object" &&
      !Array.isArray(body.buyer_limits),
  );
  if (Object.hasOwn(body, "merchant_profile")) {
    check(Object.hasOwn(PROFILES, body.merchant_profile));
  }
  return context(body.url);
}
function envelope(challenge) {
  const items = [];
  if (challenge.bodyText) {
    try {
      items.push(parse(challenge.bodyText));
    } catch {
      /* non-JSON bodies are ordinary for native Payment headers */
    }
  }
  if (challenge.paymentRequired !== null) {
    try {
      items.push(
        parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            decode64(challenge.paymentRequired),
          ),
        ),
      );
    } catch {
      return null;
    }
  }
  if (!items.length) return null;
  if (!items.every((v) => canonical(v) === canonical(items[0]))) return null;
  return items[0];
}
function paymentHits(challenge) {
  const raw = challenge.wwwAuthenticate;
  if (typeof raw !== "string" || !raw.startsWith("Payment ")) return [];
  let items;
  try {
    items = nativeChargeChallenges(raw);
  } catch {
    return [];
  }
  const known = [];
  for (const item of items) {
    const intent = item.params.intent;
    const method = item.params.method;
    if (intent === "session" && method === "solana") {
      known.push(["sess", "solana-mpp-session-v1"]);
    } else if (intent === "charge" && method === "evm") {
      known.push(["mpp", "base-mpp-charge-v1"]);
    } else if (intent === "charge" && method === "algorand") {
      known.push(["mpp", "algorand-mpp-charge-v1"]);
    }
  }
  return [...new Map(known.map((item) => [item.join("\0"), item])).values()];
}
function bodyHits(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return [];
  const ext = env.extensions;
  const manifest = ext && typeof ext === "object" ? ext[EXTENSION] : null;
  if (manifest && typeof manifest === "object") {
    if (manifest.version === 2 && manifest.profile === ALGO_INVOICE) {
      return [["inv", ALGO_INVOICE]];
    }
    if (manifest.version === 2 && manifest.profile === ALGO_MULTI) {
      return [["atom", ALGO_MULTI]];
    }
    if (manifest.version === 1) {
      if ("itemCount" in manifest && !("jobHashes" in manifest)) return [];
      if (manifest.itemCount === 2 && "jobHashes" in manifest) {
        const resource =
          env.resource && typeof env.resource === "object" ? env.resource.url : null;
        if (typeof resource === "string" && resource.includes("/algorand/batch/sha256?")) {
          return [["atom", "algorand-atomic-batch-v1"]];
        }
        return [["atom", "algorand-atomic-two-item-v1"]];
      }
    }
    return [];
  }
  const accepts = env.accepts;
  if (
    Array.isArray(accepts) &&
    accepts.length === 1 &&
    accepts[0] &&
    typeof accepts[0] === "object" &&
    accepts[0].scheme === "batch-settlement"
  ) {
    return [["exact", "base-x402-batch-v1"]];
  }
  return [];
}
function detectProfile(challenge) {
  exactKeys(challenge, ["status", "bodyText", "paymentRequired", "wwwAuthenticate"]);
  check(challenge.status === 402);
  const hits = paymentHits(challenge);
  const env = envelope(challenge);
  if (env !== null) hits.push(...bodyHits(env));
  const unique = [...new Map(hits.map((item) => [item.join("\0"), item])).values()];
  check(unique.length === 1);
  const [codec, profile] = unique[0];
  check(PROFILE_CODEC[profile] === codec && CODECS.includes(codec));
  return profile;
}
function keySet(keys) {
  return [...keys].sort().join("\0");
}
function limitsMatch(limits) {
  check(limits && typeof limits === "object" && !Array.isArray(limits));
  const keys = keySet(Object.keys(limits));
  const mapping = [
    [
      [
        "network",
        "asset",
        "recipient",
        "receiver_authorizer",
        "withdraw_delay_seconds",
        "max_call_amount_atomic",
        "max_capital_atomic",
        "max_cumulative_amount_atomic",
      ],
      "exact",
      "base-x402-batch-v1",
    ],
    [
      [
        "network",
        "asset",
        "recipient",
        "operator",
        "program_id",
        "max_session_cap_atomic",
      ],
      "sess",
      "solana-mpp-session-v1",
    ],
    [
      ["network", "asset", "recipient", "max_call_amount_atomic", "realm"],
      "mpp",
      "base-mpp-charge-v1",
    ],
    [
      [
        "network",
        "asset",
        "recipient",
        "realm",
        "max_amount_atomic",
        "max_network_fee_micro_algo",
        "fee_payer",
      ],
      "mpp",
      "algorand-mpp-charge-v1",
    ],
    [
      [
        "network",
        "asset",
        "recipient",
        "fee_payer",
        "max_total_amount_atomic",
        "max_sponsor_fee_micro_algo",
      ],
      "atom",
      "algorand-atomic-batch-v1",
    ],
    [
      [
        "network",
        "asset",
        "recipient",
        "fee_payer",
        "max_item_amount_atomic",
        "max_total_amount_atomic",
        "max_sponsor_fee_micro_algo",
        "job_hashes",
      ],
      "atom",
      null,
    ],
    [
      [
        "network",
        "asset",
        "recipient",
        "fee_payer",
        "max_total_amount_atomic",
        "max_sponsor_fee_micro_algo",
        "job_hashes",
      ],
      "inv",
      ALGO_INVOICE,
    ],
  ];
  const hits = mapping.filter((item) => keySet(item[0]) === keys);
  check(hits.length === 1);
  return [hits[0][1], hits[0][2]];
}
function resolveProfile(body, challenge) {
  const detected = detectProfile(challenge);
  const [limitsCodec, limitsProfile] = limitsMatch(body.buyer_limits);
  check(PROFILE_CODEC[detected] === limitsCodec);
  if (limitsProfile !== null) check(limitsProfile === detected);
  if (Object.hasOwn(body, "merchant_profile")) {
    check(body.merchant_profile === detected);
    check(PROFILE_CODEC[body.merchant_profile] === PROFILE_CODEC[detected]);
  }
  return detected;
}
function resultIdentityOk(body, result, profile) {
  const codec = PROFILE_CODEC[profile];
  if (Object.hasOwn(body, "merchant_profile")) {
    check(result.merchant_profile === body.merchant_profile);
  }
  if (
    !Object.hasOwn(body, "merchant_profile") ||
    Object.hasOwn(result, "job") ||
    Object.hasOwn(result, "codec")
  ) {
    check(result.job === JOB && result.codec === codec);
    if (Object.hasOwn(result, "label")) check(result.label === LABEL);
  }
}
function wire(c, ctx, profile, limits = {}) {
  exactKeys(c, ["status", "bodyText", "paymentRequired", "wwwAuthenticate"]);
  check(
    c.status === 402 &&
      typeof c.bodyText === "string" &&
      Buffer.byteLength(c.bodyText) <= 16384,
  );
  for (const k of ["paymentRequired", "wwwAuthenticate"])
    check(
      c[k] === null ||
        (typeof c[k] === "string" &&
          c[k].length > 0 &&
          c[k].length <= 16384 &&
          /^[\x20-\x7e]+$/.test(c[k])),
    );
  check(Buffer.byteLength(canonical(c)) <= 24576);
  if (profile === "algorand-mpp-charge-v1") return nativeChargeWire(c,ctx,"algorand",limits.realm,e=>validateAlgorandChargeProfile(e,ctx,limits));
  if (profile === "base-mpp-charge-v1") return nativeChargeWire(c,ctx,"evm",limits.realm,e=>validateBaseChargeProfile(e,ctx,limits));
  if (profile === "solana-mpp-session-v1") {
    check(
      c.bodyText === "" &&
        c.paymentRequired === null &&
        typeof c.wwwAuthenticate === "string" &&
        c.wwwAuthenticate.startsWith("Payment "),
    );
    const p = {};
    for (const item of c.wwwAuthenticate.slice(8).split(", ")) {
      const m = /^([A-Za-z]+)="([^"\\]*)"$/.exec(item);
      check(m && !Object.hasOwn(p, m[1]));
      p[m[1]] = m[2];
    }
    exactKeys(p, ["id", "realm", "method", "intent", "request", "expires"]);
    check(
      p.id.length > 0 &&
        p.id.length <= 256 &&
        p.realm === new URL(ctx.url).hostname &&
        p.method === "solana" &&
        p.intent === "session",
    );
    check(/^[A-Za-z0-9_-]+$/.test(p.request));
    const bytes = Buffer.from(p.request, "base64url");
    check(bytes.toString("base64url") === p.request);
    check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(p.expires));
    const milliseconds = Date.parse(p.expires),
      expiry = Math.floor(milliseconds / 1000);
    check(Number.isSafeInteger(expiry));
    const normalized = p.expires.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_, fraction) => "." + (fraction ?? "").padEnd(3, "0") + "Z",
    );
    check(new Date(milliseconds).toISOString() === normalized);
    return [
      parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      expiry,
    ];
  }
  check(c.wwwAuthenticate === null);
  const values = [];
  if (c.bodyText) values.push(parse(c.bodyText));
  if (c.paymentRequired !== null)
    values.push(
      parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          decode64(c.paymentRequired),
        ),
      ),
    );
  check(
    values.length > 0 &&
      values.every((x) => canonical(x) === canonical(values[0])),
  );
  return [values[0], null];
}
function validate(binding, body, now) {
  exactKeys(binding, [
    "model",
    "profile",
    "request",
    "buyer_limits",
    "challenge",
    "challenge_sha256",
    "terms",
    "observed_at",
    "expires_at",
  ]);
  const ctx = request(body);
  check(Number.isSafeInteger(binding.observed_at) && binding.observed_at > 0);
  const profile = resolveProfile(body, binding.challenge);
  check(binding.profile === profile);
  let [envelope, expiry] = wire(
    binding.challenge,
    ctx,
    profile,
    body.buyer_limits,
  );
  const terms = PROFILES[profile](
    JSON.parse(canonical(envelope)),
    ctx,
    JSON.parse(canonical(body.buyer_limits)),
  );
  if ([ALGO_MULTI, ALGO_INVOICE].includes(profile)) {
    check(terms.feeQuote.observedAt <= binding.observed_at && binding.observed_at < terms.feeQuote.expiresAt);
    expiry = terms.feeQuote.expiresAt;
  }
  const rebuilt = {
    model: MODEL,
    profile,
    request: ctx,
    buyer_limits: body.buyer_limits,
    challenge: binding.challenge,
    challenge_sha256: sha(canonical(binding.challenge)).toString("hex"),
    terms,
    observed_at: binding.observed_at,
    expires_at: Math.min(
      binding.observed_at + 60,
      expiry ?? binding.observed_at + 60,
    ),
  };
  check(
    rebuilt.expires_at > rebuilt.observed_at &&
      canonical(binding) === canonical(rebuilt) &&
      Number.isSafeInteger(now) &&
      binding.observed_at <= now &&
      now < binding.expires_at,
  );
  return rebuilt;
}
/** Verifies an observation only. Wallet policy and independent on-chain checks remain mandatory. */
export function verifyBatchRoute(options) {
  try {
    exactKeys(
      options,
      Object.hasOwn(options, "now")
        ? [
            "routeResponseJson",
            "routeRequestJson",
            "trustedLogVkey",
            "challenge",
            "now",
          ]
        : [
            "routeResponseJson",
            "routeRequestJson",
            "trustedLogVkey",
            "challenge",
          ],
    );
    const response = parse(options.routeResponseJson, { limit: 256 * 1024 }),
      body = parse(options.routeRequestJson);
    const evidence = authenticate(
      response.pq_trust.transparency,
      options.trustedLogVkey,
    );
    check(canonical(parse(evidence.request_json)) === canonical(body));
    const binding = validate(
      evidence.batch_binding,
      body,
      options.now ?? Math.floor(Date.now() / 1000),
    );
    check(
      canonical(response.batch_binding) === canonical(binding) &&
        canonical(options.challenge) === canonical(binding.challenge),
    );
    check(
      response.live === true &&
        response.payable === true &&
        response.url === body.url &&
        response.status === 402 &&
        response.selected_payment === null &&
        canonical(response.batch_terms) === canonical(binding.terms),
    );
    resultIdentityOk(body, response, binding.profile);
    return JSON.parse(canonical(binding));
  } catch (error) {
    if (error instanceof RouteGuardError) throw error;
    fail("invalid_batch_binding");
  }
}
export async function withVerifiedBatchRoute(options, callback) {
  const observation = verifyBatchRoute(options);
  if (typeof callback !== "function") fail("invalid_callback");
  return callback(observation);
}
