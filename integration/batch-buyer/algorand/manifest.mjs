/** Buyer-owned v2 manifests. Pure planning, explicit signing, one ordinary send. */
import { Address } from "@algorandfoundation/algokit-utils";
import { Transaction, TransactionType, groupTransactions, encodeTransactionRaw, decodeTransaction, decodeSignedTransaction, encodeSignedTransaction, bytesForSigning, transactionCodec, } from "@algorandfoundation/algokit-utils/transact";
import { ed25519Verifier } from "@algorandfoundation/algokit-utils/crypto";
import { checkAlgorandBatchGroup } from "./policy.mjs";
import { assert, canonical, digest, decode64, encode64, } from "./json.mjs";
// @ts-expect-error Independent JS profile synchronized by the package manifest.
import * as manifestProfile from "./manifest-profile.mjs";
const { validateAlgorandManifestProfile, validateAlgorandManifestLimits, validateAlgorandFeeQuote, } = manifestProfile;
export const ALGORAND_MANIFEST_EXTENSION = "402signal-atomic-batch";
export const ALGORAND_MANIFEST_HEADER_MAX = 16384;
const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const GENESIS = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const ATOMIC = "algorand-atomic-multi-item-v1";
const unknown = () => ({
    status: 503,
    body: {
        error: "algorand_manifest_outcome_unknown",
        new_payment_allowed: false,
    },
});
const key = (id, stage) => digest(canonical(["algorand-manifest-v2", id, stage]));
const snapshot = (value) => JSON.parse(canonical(value));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const context = (url) => ({
    url,
    method: "GET",
    body_sha256: digest(""),
});
const count = (profile, limits) => (profile === ATOMIC ? limits.job_hashes.length : 1);
export function quoteAlgorandManifestFees(params, paymentCount, now = nowSeconds(), lifetime = 45) {
    assert(Number.isSafeInteger(paymentCount) &&
        paymentCount >= 1 &&
        paymentCount <= 15 &&
        Number.isSafeInteger(now) &&
        now > 0 &&
        Number.isSafeInteger(lifetime) &&
        lifetime >= 1 &&
        lifetime <= 60, "fee_quote_scope_refused");
    assert(params?.["genesis-hash"] === GENESIS &&
        params["genesis-id"] === "mainnet-v1.0" &&
        Number.isSafeInteger(params["last-round"]) &&
        params["last-round"] > 0 &&
        params.fee === 0 &&
        Number.isSafeInteger(params["min-fee"]) &&
        params["min-fee"] >= 1000 &&
        params["min-fee"] <= 5000, "unsupported_fee_quote");
    const q = {
        network: NETWORK,
        genesisHash: GENESIS,
        genesisId: "mainnet-v1.0",
        transactionCount: paymentCount + 1,
        firstValid: String(params["last-round"] + 1),
        lastValid: String(params["last-round"] + 101),
        minFeeMicroAlgo: String(params["min-fee"]),
        feePerByteMicroAlgo: "0",
        sponsorFeeMicroAlgo: String(params["min-fee"] * (paymentCount + 1)),
        observedAt: now,
        expiresAt: now + lifetime,
    };
    validateAlgorandFeeQuote(q, paymentCount);
    return q;
}
export function checkCurrentAlgorandManifestQuote(quote, params, now = nowSeconds()) {
    validateAlgorandFeeQuote(quote, quote.transactionCount - 1);
    quoteAlgorandManifestFees(params, quote.transactionCount - 1, now);
    assert(now >= quote.observedAt &&
        now < quote.expiresAt &&
        String(params["min-fee"]) === quote.minFeeMicroAlgo &&
        params.fee === 0 &&
        BigInt(params["last-round"]) >= BigInt(quote.firstValid) - 1n &&
        BigInt(params["last-round"]) <= BigInt(quote.lastValid), "fee_quote_stale_or_changed");
}
export function createAlgorandManifestOffer(profile, url, requirement, limits, quote) {
    validateAlgorandManifestLimits(profile, limits);
    const payments = count(profile, limits);
    validateAlgorandFeeQuote(quote, payments);
    const manifest = {
        version: 2,
        profile,
        network: requirement.network,
        asset: requirement.asset,
        recipient: requirement.payTo,
        resource: url,
        requestHash: digest(canonical(context(url))),
        jobCount: limits.job_hashes.length,
        paymentCount: payments,
        paymentAmount: requirement.amount,
        perJobAmount: profile === ATOMIC ? requirement.amount : null,
        totalAmount: String(BigInt(requirement.amount) * BigInt(payments)),
        paymentIndices: Array.from({ length: payments }, (_, i) => i + 1),
        sponsorIndex: 0,
        feePayer: requirement.extra?.feePayer,
        jobHashes: limits.job_hashes,
        feeQuote: quote,
    };
    const envelope = {
        x402Version: 2,
        resource: { url, mimeType: "application/json" },
        accepts: [requirement],
        extensions: { [ALGORAND_MANIFEST_EXTENSION]: manifest },
    };
    validateAlgorandManifestProfile(envelope, context(url), limits, profile);
    return snapshot(envelope);
}
export function buildAlgorandManifestTransactions(profile, envelope, limits, buyer) {
    const manifest = validateAlgorandManifestProfile(envelope, context(envelope.resource?.url), limits, profile), req = envelope.accepts[0], q = manifest.feeQuote;
    const shared = {
        genesisHash: Buffer.from(GENESIS, "base64"),
        genesisId: "mainnet-v1.0",
        firstValid: BigInt(q.firstValid),
        lastValid: BigInt(q.lastValid),
    };
    const note = (i) => Buffer.from(`s2:${digest(canonical(manifest))}:${i}`);
    const transactions = [
        new Transaction({
            ...shared,
            type: TransactionType.Payment,
            sender: Address.fromString(req.extra.feePayer),
            fee: BigInt(q.sponsorFeeMicroAlgo),
            note: note(0),
            payment: { receiver: Address.fromString(req.extra.feePayer), amount: 0n },
        }),
        ...manifest.paymentIndices.map((i) => new Transaction({
            ...shared,
            type: TransactionType.AssetTransfer,
            sender: Address.fromString(buyer),
            fee: 0n,
            note: note(i),
            assetTransfer: {
                receiver: Address.fromString(req.payTo),
                assetId: BigInt(req.asset),
                amount: BigInt(req.amount),
            },
        })),
    ];
    return groupTransactions(transactions).map(encodeTransactionRaw);
}
export function prepareAlgorandManifest(input) {
    const { profile, buyer } = input, envelope = snapshot(input.envelope), limits = snapshot(input.limits);
    const manifest = validateAlgorandManifestProfile(envelope, context(envelope.resource?.url), limits, profile);
    assert(Array.isArray(input.raw) && input.raw.length === manifest.paymentCount + 1, "manifest_group_size_refused");
    const raw = input.raw.map((b) => new Uint8Array(b)), req = envelope.accepts[0];
    const group = checkAlgorandBatchGroup(raw, manifest.paymentIndices, Array.from({ length: manifest.paymentCount }, () => req), buyer, limits.max_total_amount_atomic, BigInt(limits.max_sponsor_fee_micro_algo));
    const expected = buildAlgorandManifestTransactions(profile, envelope, limits, buyer);
    assert(raw.every((b, i) => Buffer.from(b).equals(Buffer.from(expected[i]))), "manifest_unsigned_group_mismatch");
    assert(new Set(raw.map((b) => decodeTransaction(b).txId())).size === raw.length, "manifest_duplicate_transaction");
    // Exact Ed25519 wrapper size is known before any wallet signs. Reject an
    // otherwise valid large offer if its eventual credential cannot fit the wire.
    const sizedPayment = {
        x402Version: 2,
        resource: envelope.resource,
        accepted: envelope.accepts[0],
        extensions: envelope.extensions,
        payload: {
            paymentGroup: raw.map((b, i) => Buffer.from(i
                ? encodeSignedTransaction({
                    txn: decodeTransaction(b),
                    sig: new Uint8Array(64).fill(1),
                })
                : b).toString("base64")),
            paymentIndex: 1,
        },
    };
    assert(encode64(sizedPayment).length <= ALGORAND_MANIFEST_HEADER_MAX, "manifest_header_too_large");
    const id = digest(canonical([profile, NETWORK, group.groupId])), scope = digest(canonical({ profile, envelope, limits, buyer, groupId: group.groupId }));
    return { profile, envelope, limits, buyer, raw, manifest, id, scope, group };
}
export async function signAlgorandManifest(input, sign, now = nowSeconds()) {
    const p = prepareAlgorandManifest(input), q = p.manifest.feeQuote;
    assert(now >= q.observedAt && now < q.expiresAt, "fee_quote_expired");
    const signed = await sign(p.raw.map((b) => new Uint8Array(b)), [...p.manifest.paymentIndices]);
    assert(Array.isArray(signed) && signed.length === p.raw.length && !signed[0], "manifest_signer_roles_refused");
    const group = [Buffer.from(p.raw[0]).toString("base64")];
    for (const i of p.manifest.paymentIndices) {
        const bytes = signed[i];
        assert(bytes instanceof Uint8Array && bytes.length <= 4096, "manifest_signature_refused");
        const s = decodeSignedTransaction(bytes);
        assert(Buffer.from(encodeTransactionRaw(s.txn)).equals(Buffer.from(p.raw[i])) &&
            Buffer.from(encodeSignedTransaction(s)).equals(Buffer.from(bytes)) &&
            s.sig?.length === 64 &&
            !s.msig &&
            !s.lsig &&
            !s.authAddress, "manifest_signed_group_mismatch");
        assert(await ed25519Verifier(s.sig, bytesForSigning.transaction(s.txn), Address.fromString(p.buyer).publicKey), "manifest_signature_refused");
        group.push(Buffer.from(bytes).toString("base64"));
    }
    const payment = {
        x402Version: 2,
        resource: p.envelope.resource,
        accepted: p.envelope.accepts[0],
        extensions: p.envelope.extensions,
        payload: { paymentGroup: group, paymentIndex: 1 },
    };
    assert(encode64(payment).length <= ALGORAND_MANIFEST_HEADER_MAX, "manifest_header_too_large");
    return payment;
}
export async function checkSignedAlgorandManifest(profile, envelope, limits, buyer, payment) {
    assert(canonical(payment.accepted) === canonical(envelope.accepts[0]) &&
        canonical(payment.resource) === canonical(envelope.resource) &&
        canonical(payment.extensions) === canonical(envelope.extensions) &&
        payment.x402Version === 2 &&
        Object.keys(payment).sort().join(",") ===
            "accepted,extensions,payload,resource,x402Version", "manifest_payment_scope_refused");
    const data = payment.payload;
    assert(data &&
        Object.keys(data).sort().join(",") === "paymentGroup,paymentIndex" &&
        data.paymentIndex === 1 &&
        Array.isArray(data.paymentGroup) &&
        data.paymentGroup.length === count(profile, limits) + 1, "manifest_payment_shape_refused");
    const raw = data.paymentGroup.map((s, i) => {
        const b = decode64(s, 4096);
        return i === 0 ? b : encodeTransactionRaw(decodeSignedTransaction(b).txn);
    });
    const plan = prepareAlgorandManifest({
        profile,
        envelope,
        limits,
        buyer,
        raw,
    });
    // Verify every existing signature without calling any wallet.
    const reproduced = await signAlgorandManifest(plan, async () => data.paymentGroup.map((s, i) => i ? decode64(s, 4096) : undefined), plan.manifest.feeQuote.observedAt);
    assert(canonical(reproduced) === canonical(payment), "manifest_signed_group_mismatch");
    return plan;
}
export function validateAlgorandManifestReceipt(plan, out) {
    const b = out.body;
    assert(out.status === 200 &&
        b?.billing?.settlement_state === "provider_ack" &&
        b.billing.amount_atomic === plan.group.totalAtomic &&
        b.billing.sponsor_fee_micro_algo ===
            plan.manifest.feeQuote.sponsorFeeMicroAlgo &&
        b.batch?.profile === plan.profile &&
        b.batch.groupId === plan.group.groupId &&
        b.batch.jobCount === plan.manifest.jobCount &&
        b.batch.paymentCount === plan.manifest.paymentCount &&
        Array.isArray(b.batch.items) &&
        b.batch.items.length === plan.manifest.jobCount, "manifest_receipt_unknown");
    for (let i = 0; i < b.batch.items.length; i++) {
        const item = b.batch.items[i], paymentIndex = plan.profile === ATOMIC ? i + 1 : 1;
        assert(item.index === i + 1 &&
            item.jobHash === plan.limits.job_hashes[i] &&
            item.paymentIndex === paymentIndex &&
            item.transaction ===
                plan.group.transfers[paymentIndex - 1].transaction, "manifest_receipt_unknown");
    }
    return snapshot(out);
}
/** authorize is an idempotent guard/reservation callback, called before signing
 * and again before transport. It must validate the fresh router proof, SAME
 * independently confirmed fee and full campaign budget without making a payment.
 * Signers only sign; send is the sole merchant submission. */
export async function executeAlgorandManifest(store, operationId, input, options) {
    assert(/^[A-Za-z0-9_-]{1,64}$/.test(operationId), "manifest_operation_id_refused");
    const p = prepareAlgorandManifest(input), clock = options.now ?? nowSeconds;
    const binding = {
        scope: p.scope,
        plan: { ...p, raw: p.raw.map((b) => Buffer.from(b).toString("base64")) },
    };
    if (!store.once(key(operationId, "attempt"), binding)) {
        assert(store.get(key(operationId, "attempt"))?.scope === p.scope, "manifest_scope_conflict");
        const saved = store.get(key(operationId, "outcome"));
        return saved ? validateAlgorandManifestReceipt(p, saved) : unknown();
    }
    try {
        assert(store.once(key(p.id, "plan-authority"), { operationId, scope: p.scope }), "manifest_authority_already_claimed");
        await options.authorize(prepareAlgorandManifest(p));
        checkCurrentAlgorandManifestQuote(p.manifest.feeQuote, await options.readParams(), clock());
        store.once(key(operationId, "sign-permit"), { scope: p.scope });
        const payment = await signAlgorandManifest(p, options.sign, clock());
        store.once(key(operationId, "credential"), payment);
        // An approval/signing prompt can outlive the observed fee and route quote.
        await options.authorize(prepareAlgorandManifest(p));
        checkCurrentAlgorandManifestQuote(p.manifest.feeQuote, await options.readParams(), clock());
        assert(store.once(key(operationId, "send-permit"), { scope: p.scope }), "manifest_send_already_claimed");
        const out = await options.send(p.envelope.resource.url, payment);
        const valid = validateAlgorandManifestReceipt(p, out);
        store.once(key(operationId, "outcome"), valid);
        return valid;
    }
    catch {
        return unknown();
    }
}
export async function recoverAlgorandManifest(store, operationId, input, read) {
    try {
        const p = prepareAlgorandManifest(input), binding = store.get(key(operationId, "attempt"));
        assert(binding?.scope === p.scope, "manifest_scope_conflict");
        const saved = store.get(key(operationId, "outcome"));
        if (saved)
            return validateAlgorandManifestReceipt(p, saved);
        assert(store.get(key(operationId, "send-permit"))?.scope === p.scope, "manifest_never_submitted");
        const payment = store.get(key(operationId, "credential"));
        await checkSignedAlgorandManifest(p.profile, p.envelope, p.limits, p.buyer, payment);
        const response = await read({
            recoveryOnly: true,
            url: p.envelope.resource.url,
            groupId: p.group.groupId,
            requestDigest: p.scope,
            authorizationDigest: digest(canonical(payment)),
        });
        assert(response?.recoveryOnly === true, "manifest_recovery_contract_required");
        const { recoveryOnly: _, ...outcome } = response;
        const valid = validateAlgorandManifestReceipt(p, outcome);
        store.once(key(operationId, "outcome"), valid);
        return valid;
    }
    catch {
        return unknown();
    }
}
/** Independent group confirmation, never merchant success or a retry decision. */
export async function confirmAlgorandManifestOnce(input, rpcUrl, read) {
    try {
        const p = prepareAlgorandManifest(input), u = new URL(rpcUrl);
        assert(u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash, "rpc_scope_refused");
        const endpoint = rpcUrl.endsWith("/") ? rpcUrl.slice(0, -1) : rpcUrl;
        const params = await read(endpoint + "/v2/transactions/params");
        assert(params.status === 200 &&
            params.body?.["genesis-hash"] === GENESIS &&
            params.body?.["genesis-id"] === "mainnet-v1.0", "wrong_network");
        let round;
        const transactions = [];
        for (const raw of p.raw) {
            const expected = decodeTransaction(raw), id = expected.txId(), found = await read(endpoint + "/v2/transactions/pending/" + id), n = found.body?.["confirmed-round"];
            assert(found.status === 200 &&
                Number.isSafeInteger(n) &&
                n > 0 &&
                !found.body?.["pool-error"], "group_unconfirmed");
            const actual = transactionCodec.decode(found.body?.txn?.txn, "json");
            assert(Buffer.from(encodeTransactionRaw(actual)).equals(Buffer.from(raw)) &&
                actual.txId() === id, "group_effect_mismatch");
            if (round === undefined)
                round = n;
            else
                assert(round === n, "group_round_mismatch");
            transactions.push(id);
        }
        return {
            state: "confirmed",
            groupId: p.group.groupId,
            confirmedRound: round,
            transactions,
            jobCount: p.manifest.jobCount,
            paymentCount: p.manifest.paymentCount,
            totalAtomic: p.group.totalAtomic,
            buyerNativeFeeAtomic: "0",
            sponsorFeeMicroAlgo: p.manifest.feeQuote.sponsorFeeMicroAlgo,
        };
    }
    catch {
        return { state: "unknown" };
    }
}
//# sourceMappingURL=algorand-manifest.js.map