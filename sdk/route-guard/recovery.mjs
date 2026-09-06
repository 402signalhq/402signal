/** Read-only reconciliation. The supplied observer must independently verify
 * chain effects against the caller's durable intent. No signer is accepted. */
const RAILS = {
  base: { pattern: /^0x[0-9a-fA-F]{64}$/, level: 'base_two_blocks_not_finality' },
  solana: { pattern: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/, level: 'solana_finalized' },
  algorand: { pattern: /^[A-Z2-7]{52}$/, level: 'algorand_confirmed_round' },
};

function bounded(value, fallback, min, max) {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new TypeError('invalid_recovery_options');
  return v;
}

export async function reconcilePayment(options) {
  const {rail, transaction, observe, signal} = options;
  const policy = RAILS[rail];
  if (!policy || typeof transaction !== 'string' || !policy.pattern.test(transaction) || typeof observe !== 'function')
    throw new TypeError('existing_payment_required');
  const max = bounded(options.maxObservations, rail === 'solana' ? 30 : 8, 1, 60);
  const interval = bounded(options.intervalMs, rail === 'solana' ? 2000 : 1000, 0, 5000);
  const timeout = bounded(options.timeoutMs, 60000, 1, 120000);
  const start = performance.now();
  let observations = 0;
  const result = (state, reason, confirmation) => Object.freeze({
    state, reason, rail, transaction, observations,
    elapsed_ms: Math.max(0, Math.round(performance.now() - start)),
    payment_resubmitted: false, seller_execution_resumed: false, budget_released: false,
    ...(confirmation ? {confirmation: Object.freeze(confirmation)} : {}),
  });
  for (let i = 0; i < max; i++) {
    if (signal?.aborted) return result('unknown', 'aborted');
    const remaining = timeout - (performance.now() - start);
    if (remaining <= 0) return result('unknown', 'confirmation_timeout');
    const controller = new AbortController();
    let timer, onAbort;
    const expired = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, remaining);
      onAbort = () => { controller.abort(); resolve(null); };
      signal?.addEventListener('abort', onAbort, {once: true});
    });
    let confirmation;
    try {
      observations++;
      confirmation = await Promise.race([
        Promise.resolve().then(() => observe(Object.freeze({rail, transaction, signal: controller.signal}))).catch(() => null),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) return result('unknown', 'aborted');
    if (performance.now() - start >= timeout) {
      controller.abort();
      return result('unknown', 'confirmation_timeout');
    }
    if (confirmation?.state === 'confirmed') {
      if (confirmation.transaction !== transaction || confirmation.level !== policy.level || confirmation.buyer_native_fee_atomic !== '0')
        return result('unknown', 'confirmation_scope_mismatch');
      return result('confirmed', 'chain_verified', {state: 'confirmed', transaction,
        level: policy.level, buyer_native_fee_atomic: '0'});
    }
    const remainingWait = timeout - (performance.now() - start);
    if (remainingWait <= 0) return result('unknown', 'confirmation_timeout');
    if (i + 1 < max && interval) {
      await new Promise(resolve => {
        const finish = () => {clearTimeout(t); signal?.removeEventListener('abort', finish); resolve();};
        const t = setTimeout(finish, Math.min(interval, remainingWait));
        signal?.addEventListener('abort', finish, {once: true});
      });
    }
  }
  return result('unknown', 'confirmation_pending');
}
