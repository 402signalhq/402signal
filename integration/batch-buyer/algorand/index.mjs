// Buyer-owned two-item atomic group. No wallet keys, network, or automatic retry.
import { Address } from "@algorandfoundation/algokit-utils";
import { Transaction, TransactionType, groupTransactions, encodeTransactionRaw, decodeTransaction, decodeSignedTransaction, bytesForSigning, transactionCodec, } from "@algorandfoundation/algokit-utils/transact";
import { ed25519Verifier } from "@algorandfoundation/algokit-utils/crypto";
import { checkAlgorandBatchGroup } from "./policy.mjs";
const ALGO_GENESIS = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
import { assert, canonical, digest } from "./json.mjs";
// @ts-expect-error The independently maintained pure guard is a native JS module.
import { validateAlgorandGenericProfile } from "./generic-profile.mjs";
export const ALGORAND_BATCH_PATH = "/algorand/batch/sha256";
export function algorandBatchRequest(url, origin) {
    const u = new URL(url), base = new URL(origin);
    assert(base.protocol === "https:" &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash &&
        base.pathname === "/" &&
        u.origin === base.origin &&
        u.pathname === ALGORAND_BATCH_PATH &&
        !u.username &&
        !u.password &&
        !u.hash &&
        url.length <= 4096, "algorand_batch_resource_refused");
    assert(!/%(?![0-9a-fA-F]{2})/.test(u.search), "algorand_batch_input_refused");
    try {
        decodeURIComponent(u.search.replace(/\+/g, " "));
    }
    catch {
        throw new Error("algorand_batch_input_refused");
    }
    const entries = [...u.searchParams];
    assert(entries.length === 2 &&
        entries.filter(([k]) => k === "left").length === 1 &&
        entries.filter(([k]) => k === "right").length === 1, "algorand_batch_input_refused");
    const texts = ["left", "right"].map((k) => u.searchParams.get(k));
    assert(texts.every((s) => s.length > 0 && s.length <= 1024 && !/[\uD800-\uDFFF]/u.test(s)), "algorand_batch_input_refused");
    return {
        url,
        items: texts.map((text, i) => ({
            index: i + 1,
            result: { sha256: digest(text) },
        })),
    };
}
export const ALGORAND_BATCH_EXTENSION = "402signal-atomic-batch";
export function algorandBatchManifest(url, origin, requirement) {
    const request = algorandBatchRequest(url, origin);
    assert(requirement.amount === "1000" &&
        typeof requirement.extra?.feePayer === "string", "algorand_batch_unit_price_refused");
    return {
        version: 1,
        network: requirement.network,
        asset: requirement.asset,
        recipient: requirement.payTo,
        resource: url,
        requestHash: digest(canonical({ url, method: "GET", body_sha256: digest("") })),
        itemCount: 2,
        itemAmount: "1000",
        totalAmount: "2000",
        paymentIndices: [1, 2],
        sponsorIndex: 0,
        feePayer: requirement.extra.feePayer,
        maxSponsorFeeMicroAlgo: "15000",
        jobHashes: request.items.map((item) => item.result.sha256),
    };
}
export function buildAlgorandBatchTransactions(requirement, buyer, firstValid, lastValid) {
    assert(typeof firstValid === "bigint" && typeof lastValid === "bigint", "algorand_batch_validity_refused");
    const sponsor = requirement.extra?.feePayer;
    assert(typeof sponsor === "string", "algorand_batch_sponsor_refused");
    const shared = {
        genesisHash: Buffer.from(ALGO_GENESIS, "base64"),
        genesisId: "mainnet-v1.0",
        firstValid,
        lastValid,
    };
    const txs = groupTransactions([
        new Transaction({
            ...shared,
            type: TransactionType.Payment,
            sender: Address.fromString(sponsor),
            fee: 3000n,
            payment: { receiver: Address.fromString(sponsor), amount: 0n },
        }),
        ...[1, 2].map((i) => new Transaction({
            ...shared,
            type: TransactionType.AssetTransfer,
            sender: Address.fromString(buyer),
            fee: 0n,
            note: Buffer.from(`402signal-batch-item-${i}`),
            assetTransfer: {
                receiver: Address.fromString(requirement.payTo),
                assetId: BigInt(requirement.asset),
                amount: BigInt(requirement.amount),
            },
        })),
    ]);
    const raw = txs.map(encodeTransactionRaw);
    checkAlgorandBatchGroup(raw, [1, 2], [requirement, requirement], buyer, (BigInt(requirement.amount) * 2n).toString(), 15000n);
    return raw;
}
export function prepareAlgorandBatch(input) {
    assert(input.profile === undefined ||
        input.profile === "algorand-atomic-two-item-v1", "algorand_batch_profile_refused");
    assert((input.profile === undefined) === (input.buyerLimits === undefined), "algorand_batch_limits_required");
    const generic = input.profile === "algorand-atomic-two-item-v1";
    const request = generic
        ? { url: input.url }
        : algorandBatchRequest(input.url, input.origin);
    assert(new URL(input.url).origin === input.origin, "algorand_batch_resource_refused");
    const buyerLimits = generic
        ? JSON.parse(canonical(input.buyerLimits))
        : undefined;
    const requirement = JSON.parse(canonical(input.requirement));
    const manifest = generic
        ? validateAlgorandGenericProfile({
            x402Version: 2,
            resource: { url: input.url },
            accepts: [requirement],
            extensions: { [ALGORAND_BATCH_EXTENSION]: input.manifest },
        }, { url: input.url, method: "GET", body_sha256: digest("") }, buyerLimits)
        : algorandBatchManifest(input.url, input.origin, requirement);
    assert(canonical(manifest) === canonical(input.manifest), "algorand_batch_manifest_refused");
    assert(generic || requirement.amount === "1000", "algorand_batch_unit_price_refused");
    const raw = input.raw.map((b) => new Uint8Array(b));
    const group = checkAlgorandBatchGroup(raw, [1, 2], [requirement, requirement], input.buyer, input.maxSpendAtomic, 15000n);
    assert(group.transfers.length === 2, "algorand_batch_size_refused");
    const id = digest(canonical(["algorand-atomic-batch-v1", requirement.network, group.groupId]));
    const scope = digest(canonical({
        url: request.url,
        requirement,
        manifest,
        groupId: group.groupId,
        ...(generic ? { profile: input.profile, buyerLimits } : {}),
    }));
    return {
        id,
        scope,
        url: request.url,
        requirement,
        manifest,
        buyer: input.buyer,
        raw,
        group,
        ...(generic
            ? {
                profile: input.profile,
                buyerLimits: buyerLimits,
            }
            : {}),
    };
}
export async function signAlgorandBatch(plan, sign) {
    // Snapshot all signing inputs before crossing an asynchronous wallet boundary.
    const { url, requirement, manifest, buyer, raw } = prepareAlgorandBatch({
        url: plan.url,
        origin: new URL(plan.url).origin,
        requirement: plan.requirement,
        buyer: plan.buyer,
        raw: plan.raw,
        maxSpendAtomic: plan.group.totalAtomic,
        manifest: plan.manifest,
        profile: plan.profile,
        buyerLimits: plan.buyerLimits,
    });
    const signed = await sign(raw.map((b) => new Uint8Array(b)), [1, 2]);
    assert(Array.isArray(signed) && signed.length === 3 && !signed[0], "algorand_batch_signers_refused");
    const paymentGroup = [Buffer.from(raw[0]).toString("base64")];
    for (const index of [1, 2]) {
        const bytes = signed[index];
        assert(bytes instanceof Uint8Array && bytes.length <= 4096, "algorand_batch_signature_refused");
        const s = decodeSignedTransaction(bytes), tx = decodeTransaction(raw[index]);
        assert(Buffer.from(encodeTransactionRaw(s.txn)).equals(Buffer.from(raw[index])) &&
            s.sig?.length === 64 &&
            !s.msig &&
            !s.lsig &&
            !s.authAddress, "algorand_batch_signature_refused");
        assert(await ed25519Verifier(s.sig, bytesForSigning.transaction(tx), Address.fromString(buyer).publicKey), "algorand_batch_signature_refused");
        paymentGroup.push(Buffer.from(bytes).toString("base64"));
    }
    return {
        x402Version: 2,
        resource: { url, mimeType: "application/json" },
        accepted: requirement,
        extensions: { [ALGORAND_BATCH_EXTENSION]: manifest },
        payload: { paymentGroup, paymentIndex: 1 },
    };
}
/** The caller reserves the full campaign spend and verifies its independent route
 * receipt before calling. Durable claim precedes the wallet callback and send.
 * A restarted or concurrent attempt only retrieves; it cannot sign/send again.
 */
export async function executeAlgorandBatch(ledger, input, sign, send, authorize) {
    const plan = prepareAlgorandBatch({
        url: input.url,
        origin: new URL(input.url).origin,
        requirement: input.requirement,
        buyer: input.buyer,
        raw: input.raw,
        maxSpendAtomic: input.group.totalAtomic,
        manifest: input.manifest,
        profile: input.profile,
        buyerLimits: input.buyerLimits,
    });
    const existing = ledger.lookup(plan.id, plan.scope);
    if (existing)
        return existing.outcome;
    await authorize(structuredClone(plan.manifest));
    const claim = ledger.reserve(plan.id, plan.scope);
    if (!claim.run)
        return claim.outcome;
    ledger.attempting(plan.id);
    let outcome;
    try {
        const payment = await signAlgorandBatch(plan, sign);
        outcome = await send(plan.url, payment);
    }
    catch {
        outcome = {
            status: 503,
            body: {
                error: "algorand_batch_outcome_unknown",
                new_payment_allowed: false,
            },
        };
    }
    ledger.finish(plan.id, "attempted", outcome);
    return outcome;
}
/** Independent read-only check of every transaction, including sponsor fee. No
 * resubmission, signing, reservation release, or inference from provider success.
 */
export async function confirmAlgorandBatchOnce(input, rpcUrl, send) {
    try {
        const plan = prepareAlgorandBatch({
            url: input.url,
            origin: new URL(input.url).origin,
            requirement: input.requirement,
            buyer: input.buyer,
            raw: input.raw,
            maxSpendAtomic: input.group.totalAtomic,
            manifest: input.manifest,
            profile: input.profile,
            buyerLimits: input.buyerLimits,
        });
        const endpoint = new URL(rpcUrl);
        assert(endpoint.protocol === "https:" &&
            !endpoint.username &&
            !endpoint.password &&
            !endpoint.search &&
            !endpoint.hash, "algorand_batch_rpc_refused");
        const base = rpcUrl.replace(/\/$/, "");
        const params = await send(base + "/v2/transactions/params", "GET");
        assert(params.status === 200 &&
            params.body?.["genesis-hash"] === ALGO_GENESIS &&
            params.body?.["genesis-id"] === "mainnet-v1.0", "algorand_batch_network_refused");
        let round;
        const ids = [];
        for (const raw of plan.raw) {
            const expected = decodeTransaction(raw), id = expected.txId();
            ids.push(id);
            const found = await send(base + "/v2/transactions/pending/" + id, "GET");
            const n = found.body?.["confirmed-round"];
            assert(found.status === 200 &&
                Number.isSafeInteger(n) &&
                n > 0 &&
                !found.body?.["pool-error"], "algorand_batch_unconfirmed");
            const tx = transactionCodec.decode(found.body?.txn?.txn, "json");
            assert(tx.txId() === id &&
                Buffer.from(encodeTransactionRaw(tx)).equals(Buffer.from(raw)), "algorand_batch_confirmation_mismatch");
            if (round === undefined)
                round = n;
            else
                assert(round === n, "algorand_batch_round_mismatch");
        }
        return {
            state: "confirmed",
            groupId: plan.group.groupId,
            confirmedRound: round,
            transactions: ids,
            totalAtomic: plan.group.totalAtomic,
            buyerNativeFeeAtomic: "0",
            sponsorFeeMicroAlgo: decodeTransaction(plan.raw[0]).fee.toString(),
        };
    }
    catch {
        return { state: "unknown" };
    }
}
//# sourceMappingURL=algorand-batch.js.map