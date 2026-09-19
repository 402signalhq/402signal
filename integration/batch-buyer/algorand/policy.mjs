import { decodeTransaction, encodeTransactionRaw, groupTransactions, Transaction, } from "@algorandfoundation/algokit-utils/transact";
import { assert, canonical } from "./json.mjs";
const ALGO_GENESIS = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const atomic = (s) => {
    assert(typeof s === "string" && /^(0|[1-9][0-9]{0,19})$/.test(s), "batch_invalid_atomic");
    return BigInt(s);
};
// A deliberately narrow buyer-reviewed profile: one sponsor plus 1–15 USDC
// transfers. It does not claim that a facilitator accepts this profile, nor
// that all seller HTTP responses will succeed atomically with the transfers.
export function checkAlgorandBatchGroup(raw, signerIndexes, requirements, buyer, maxSpendAtomic, maxSponsorFeeMicroAlgo) {
    assert(requirements.length >= 1 &&
        requirements.length <= 15 &&
        raw.length === requirements.length + 1, "algorand_batch_size_refused");
    assert(canonical(signerIndexes) === canonical(requirements.map((_, i) => i + 1)), "algorand_batch_signers_refused");
    const spend = requirements.reduce((sum, r) => sum + atomic(r.amount), 0n);
    assert(spend > 0n && spend <= atomic(maxSpendAtomic), "algorand_batch_spend_cap");
    const sponsor = requirements[0].extra?.feePayer;
    assert(typeof sponsor === "string" &&
        sponsor !== buyer &&
        maxSponsorFeeMicroAlgo > 0n, "algorand_batch_sponsor_refused");
    for (const r of requirements) {
        assert(r.network === "algorand:" + ALGO_GENESIS &&
            r.asset === "31566704" &&
            r.scheme === "exact", "mainnet_terms_mismatch");
        assert(atomic(r.amount) > 0n &&
            r.extra?.feePayer === sponsor &&
            r.payTo !== buyer &&
            r.payTo !== sponsor, "algorand_batch_terms_refused");
    }
    const txs = raw.map((bytes) => {
        assert(bytes.length <= 4096, "algorand_batch_encoding_refused");
        const t = decodeTransaction(bytes);
        assert(Buffer.from(encodeTransactionRaw(t)).equals(Buffer.from(bytes)), "algorand_batch_encoding_refused");
        return t;
    });
    const f = txs[0];
    for (const t of txs) {
        assert(Buffer.from(t.genesisHash ?? []).toString("base64") === ALGO_GENESIS &&
            (!t.genesisId || t.genesisId === "mainnet-v1.0"), "algorand_batch_network_refused");
        assert(!t.rekeyTo &&
            !t.lease &&
            (t.note?.length ?? 0) <= 80 &&
            t.group?.length === 32, "algorand_batch_side_effect_refused");
        assert(t.firstValid > 0n &&
            t.lastValid >= t.firstValid &&
            t.lastValid - t.firstValid <= 1000n &&
            t.firstValid === f.firstValid &&
            t.lastValid === f.lastValid, "algorand_batch_validity_refused");
    }
    assert(f.type === "pay" &&
        f.sender.toString() === sponsor &&
        f.payment?.receiver.toString() === sponsor &&
        f.payment.amount === 0n &&
        !f.payment.closeRemainderTo &&
        (f.fee ?? 0n) >= BigInt(txs.length) * 1000n &&
        (f.fee ?? 0n) <= maxSponsorFeeMicroAlgo, "algorand_batch_fee_refused");
    requirements.forEach((r, i) => {
        const t = txs[i + 1];
        assert(t.type === "axfer" &&
            t.sender.toString() === buyer &&
            (t.fee ?? 0n) === 0n &&
            t.assetTransfer?.receiver.toString() === r.payTo &&
            t.assetTransfer.assetId === BigInt(r.asset) &&
            t.assetTransfer.amount === atomic(r.amount) &&
            !t.assetTransfer.closeRemainderTo &&
            !t.assetTransfer.assetSender, "algorand_batch_transfer_refused");
    });
    const expected = groupTransactions(txs.map((t) => new Transaction({ ...t, group: undefined })));
    txs.forEach((t, i) => assert(Buffer.from(t.group).equals(Buffer.from(expected[i].group)), "algorand_batch_group_id_refused"));
    return Object.freeze({
        groupId: Buffer.from(f.group).toString("base64"),
        totalAtomic: spend.toString(),
        transfers: Object.freeze(requirements.map((r, i) => Object.freeze({
            paymentIndex: i + 1,
            transaction: txs[i + 1].txId(),
            payTo: r.payTo,
            amountAtomic: r.amount,
        }))),
    });
}
//# sourceMappingURL=algorand-batch-policy.js.map