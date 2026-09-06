import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { decodeSignedTransaction, decodeUnsignedTransaction } from '@x402/avm';
import { encodeSignedTransaction, encodeTransaction, encodeTransactionRaw } from '@algorandfoundation/algokit-utils/transact';
import { assert, canonical, decode64, digest, object, text } from './json.js';
import type { Rail } from './config.js';

// Restrictive lab wire profile. SDK/facilitator verifies cryptography. The ledger
// keys economic authority, never signature bytes, resource metadata or request ID.
export function paymentIdentity(rail: Rail, payment: PaymentPayload, req: PaymentRequirements): string {
  const p = object(payment.payload);
  let authority: unknown;
  if (rail === 'base') {
    assert(!p.permit2Authorization, 'permit2_not_enabled_in_lab');
    const a = object(p.authorization);
    const from = text(a.from); assert(/^0x[0-9a-fA-F]{40}$/.test(from), 'invalid_authorization');
    assert(/^0x[0-9a-fA-F]{64}$/.test(text(a.nonce)), 'invalid_authorization');
    assert(/^0x[0-9a-fA-F]{40}$/.test(text(a.to)), 'invalid_authorization');
    for (const k of ['value', 'validAfter', 'validBefore']) assert(/^\d{1,78}$/.test(text(a[k])), 'invalid_authorization');
    assert(typeof p.signature === 'string' && /^0x[0-9a-fA-F]+$/.test(p.signature), 'signature_required');
    // EIP-3009 uniqueness is (token domain, authorizer, nonce), independent of
    // changed signed amounts/times or any mutable wrapper.
    authority = [from.toLowerCase(), a.nonce.toLowerCase()];
  } else if (rail === 'solana') {
    const bytes = decode64(p.transaction, 1232);
    // Use the official codec directly; the SDK convenience wrapper logs raw
    // decoder exceptions, which need not be safe for a payment-service log.
    const tx = getTransactionDecoder().decode(bytes);
    assert(Buffer.from(getTransactionEncoder().encode(tx)).equals(bytes), 'noncanonical_transaction');
    assert(tx.messageBytes.length > 0, 'invalid_transaction');
    authority = digest(new Uint8Array(tx.messageBytes));
  } else {
    assert(Array.isArray(p.paymentGroup) && p.paymentGroup.length >= 1 && p.paymentGroup.length <= 16, 'invalid_group');
    assert(Number.isInteger(p.paymentIndex) && p.paymentIndex >= 0 && p.paymentIndex < p.paymentGroup.length, 'invalid_payment_index');
    const ids = p.paymentGroup.map((item: unknown) => {
      const raw = decode64(item, 4096), b64 = raw.toString('base64');
      try {
        const s = decodeSignedTransaction(b64);
        // Reject ambiguous/noncanonical msgpack rather than allowing two parsers
        // to disagree on what was signed; signatures excluded from identity.
        assert(Buffer.from(encodeSignedTransaction(s)).equals(raw), 'noncanonical_transaction');
        return s.txn.txId();
      } catch {
        const tx = decodeUnsignedTransaction(b64);
        assert(Buffer.from(encodeTransactionRaw(tx)).equals(raw) || Buffer.from(encodeTransaction(tx)).equals(raw), 'noncanonical_transaction');
        return tx.txId();
      }
    });
    // paymentIndex is unsigned: all indices for one group share one reservation.
    authority = ids;
  }
  return digest(canonical(['lab-economic-v1', rail, req.network, rail === 'base' ? req.asset.toLowerCase() : req.asset, authority]));
}
export function matchRequirements(p: PaymentPayload, r: PaymentRequirements): boolean {
  return p.x402Version === 2 && canonical(p.accepted) === canonical(r);
}
