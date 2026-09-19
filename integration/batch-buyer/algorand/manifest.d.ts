import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Group } from "./index.mjs";
import type { AlgorandManifestJournal } from "./manifest-store.mjs";
export type AlgorandManifestProfile = "algorand-atomic-multi-item-v1" | "algorand-aggregate-invoice-v1";
export declare const ALGORAND_MANIFEST_EXTENSION = "402signal-atomic-batch";
export declare const ALGORAND_MANIFEST_HEADER_MAX = 16384;
export interface AlgorandManifestLimits {
    network: string;
    asset: string;
    recipient: string;
    fee_payer: string;
    max_total_amount_atomic: string;
    max_sponsor_fee_micro_algo: string;
    job_hashes: string[];
    max_item_amount_atomic?: string;
}
export interface AlgorandManifestFeeQuote {
    network: string;
    genesisHash: string;
    genesisId: string;
    transactionCount: number;
    firstValid: string;
    lastValid: string;
    minFeeMicroAlgo: string;
    feePerByteMicroAlgo: string;
    sponsorFeeMicroAlgo: string;
    observedAt: number;
    expiresAt: number;
}
export interface AlgorandManifestPlan {
    profile: AlgorandManifestProfile;
    envelope: any;
    limits: AlgorandManifestLimits;
    buyer: string;
    raw: Uint8Array[];
    manifest: any;
    id: string;
    scope: string;
    group: Group;
}
export interface ManifestOutcome {
    status: number;
    body: any;
    headers?: Record<string, string>;
}
export type ManifestSigner = (raw: Uint8Array[], indexes: number[]) => Promise<(Uint8Array | null | undefined)[]>;
export type ManifestRead = (url: string) => Promise<{
    status: number;
    body: any;
}>;
export declare function quoteAlgorandManifestFees(params: any, paymentCount: number, now?: number, lifetime?: number): AlgorandManifestFeeQuote;
export declare function checkCurrentAlgorandManifestQuote(quote: AlgorandManifestFeeQuote, params: any, now?: number): void;
export declare function createAlgorandManifestOffer(profile: AlgorandManifestProfile, url: string, requirement: PaymentRequirements, limits: AlgorandManifestLimits, quote: AlgorandManifestFeeQuote): {
    x402Version: number;
    resource: {
        url: string;
        mimeType: string;
    };
    accepts: PaymentRequirements[];
    extensions: {
        "402signal-atomic-batch": {
            version: number;
            profile: AlgorandManifestProfile;
            network: `${string}:${string}`;
            asset: string;
            recipient: string;
            resource: string;
            requestHash: string;
            jobCount: number;
            paymentCount: number;
            paymentAmount: string;
            perJobAmount: string | null;
            totalAmount: string;
            paymentIndices: number[];
            sponsorIndex: number;
            feePayer: unknown;
            jobHashes: string[];
            feeQuote: AlgorandManifestFeeQuote;
        };
    };
};
export declare function buildAlgorandManifestTransactions(profile: AlgorandManifestProfile, envelope: any, limits: AlgorandManifestLimits, buyer: string): Uint8Array<ArrayBufferLike>[];
export declare function prepareAlgorandManifest(input: {
    profile: AlgorandManifestProfile;
    envelope: any;
    limits: AlgorandManifestLimits;
    buyer: string;
    raw: Uint8Array[];
}): AlgorandManifestPlan;
export declare function signAlgorandManifest(input: AlgorandManifestPlan, sign: ManifestSigner, now?: number): Promise<{
    x402Version: number;
    resource: any;
    accepted: any;
    extensions: any;
    payload: {
        paymentGroup: string[];
        paymentIndex: number;
    };
}>;
export declare function checkSignedAlgorandManifest(profile: AlgorandManifestProfile, envelope: any, limits: AlgorandManifestLimits, buyer: string, payment: any): Promise<AlgorandManifestPlan>;
export declare function validateAlgorandManifestReceipt(plan: AlgorandManifestPlan, out: ManifestOutcome): ManifestOutcome;
/** authorize is an idempotent guard/reservation callback, called before signing
 * and again before transport. It must validate the fresh router proof, SAME
 * independently confirmed fee and full campaign budget without making a payment.
 * Signers only sign; send is the sole merchant submission. */
export declare function executeAlgorandManifest(store: AlgorandManifestJournal, operationId: string, input: AlgorandManifestPlan, options: {
    authorize: (plan: AlgorandManifestPlan) => Promise<void>;
    readParams: () => Promise<any>;
    sign: ManifestSigner;
    send: (url: string, payment: PaymentPayload) => Promise<ManifestOutcome>;
    now?: () => number;
}): Promise<ManifestOutcome>;
/** Recovery carries only non-executable identifiers. Never forward a signed
 * payment to a third-party endpoint that may ignore a recovery header. */
export interface ManifestRecoveryRequest {
    recoveryOnly: true;
    url: string;
    groupId: string;
    requestDigest: string;
    authorizationDigest: string;
}
export declare function recoverAlgorandManifest(store: AlgorandManifestJournal, operationId: string, input: AlgorandManifestPlan, read: (request: ManifestRecoveryRequest) => Promise<ManifestOutcome & {
    recoveryOnly: true;
}>): Promise<ManifestOutcome>;
/** Independent group confirmation, never merchant success or a retry decision. */
export declare function confirmAlgorandManifestOnce(input: AlgorandManifestPlan, rpcUrl: string, read: ManifestRead): Promise<{
    state: string;
    groupId: string;
    confirmedRound: number | undefined;
    transactions: string[];
    jobCount: any;
    paymentCount: any;
    totalAtomic: string;
    buyerNativeFeeAtomic: string;
    sponsorFeeMicroAlgo: any;
} | {
    state: string;
    groupId?: undefined;
    confirmedRound?: undefined;
    transactions?: undefined;
    jobCount?: undefined;
    paymentCount?: undefined;
    totalAtomic?: undefined;
    buyerNativeFeeAtomic?: undefined;
    sponsorFeeMicroAlgo?: undefined;
}>;
