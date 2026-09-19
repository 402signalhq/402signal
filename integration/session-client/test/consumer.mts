import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { BaseSessionClient, observeBaseBatch, type BaseSessionPlan, type BaseDepositProvider } from '@402signal/session-client/base';
import { SolanaSessionClient, prepareSolanaSession, observeSolanaOpen, observeSolanaClose, quoteSolanaSessionRent, verifySolanaSessionDeployment, type SolanaFundingPolicy, type SolanaOpenCredential } from '@402signal/session-client/solana';
import { LocalBatchLedger, LocalOperationJournal, canonical as journalCanonical } from '@402signal/session-client/ledger';
import { createSessionTransport } from '@402signal/session-client/transport';
import { hash, digest, clone, frozen, atomic, canonical, exact, check, requestSnapshot, readInitialObservation, validatePolicy, fundingFresh, continuationFresh, callScope, type SessionPolicy, type InitialObservation, type ReadRpc, type SessionResponse, type RecoveryScope } from '@402signal/session-client';

// This function is compiled, not invoked: it creates no authority or network request.
async function consumer(basePlan: BaseSessionPlan, nativePolicy: SolanaFundingPolicy, proof: InitialObservation, rpc: ReadRpc, provider: BaseDepositProvider, nativeChallenge: string, sendOpen: (c: SolanaOpenCredential) => Promise<{ reference: string }>, readReceipt: (s: RecoveryScope) => Promise<SessionResponse>) {
  const baseOwner = privateKeyToAccount('0x0707070707070707070707070707070707070707070707070707070707070707');
  const solanaOwner = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
  const request = { url: basePlan.resource, method: 'GET', body: '' } as const;
  const policy: SessionPolicy = { version: 2, maxCalls: 3, perCallAtomic: '1000', maxCumulativeAtomic: '3000', expiresAt: Date.now() + 7200000, request: { url: request.url, method: 'GET', maxBodyBytes: 0 } };
  const ledger = new LocalBatchLedger('/private/buyer-journal', 'consumer-base');
  const journal = new LocalOperationJournal(ledger);
  const transport = createSessionTransport({ fetch: globalThis.fetch, readReceipt });
  const base = new BaseSessionClient(ledger, journal, rpc, basePlan, { policy, initialObservation: proof });
  await base.initialize();
  validatePolicy(policy, basePlan, 'base');
  const payload = await base.prepareDeposit(baseOwner);
  const preparedAmount: string = payload.accepted.amount;
  await base.sendDeposit(provider);
  const deposited = await base.confirm('deposit');
  if (deposited.state === 'chain_confirmed') { const block: number = deposited.blockNumber; void block; }
  const result = await base.deliver(baseOwner, 1, request, '{}', transport.send);
  if (result.state === 'voucher_accepted') { const settled: false = result.chainSettled; const amount: string = result.authorizedCumulativeAtomic; void [settled, amount]; }
  else { const permission: false = result.newPaymentAllowed; void permission; }
  await base.recoverDelivery(1, transport.recover);
  await base.close(3);
  await base.sendCloseOperation('claim', provider);
  await base.sendCloseOperation('settle', provider);
  await base.sendRefund(provider);
  await base.confirm('refund');
  await base.closeEmpty();
  await base.sendUnspentRefund(provider);
  void observeBaseBatch;

  const nativePlan = await prepareSolanaSession({ wwwAuthenticate: nativeChallenge, request: { url: request.url, method: 'GET', digest: hash('') }, policy: nativePolicy });
  const native = new SolanaSessionClient(new LocalBatchLedger('/private/native-journal', 'consumer-solana'), nativePlan, { policy, initialObservation: proof });
  await native.initialize();
  validatePolicy(policy, nativePlan, 'solana');
  const rent = await quoteSolanaSessionRent(rpc);
  const zero: '0' = rent.buyerRentLamports;
  await verifySolanaSessionDeployment(rpc, nativePlan);
  const credential = await native.signOpen(solanaOwner, rpc);
  const authorization: string = credential.authorization;
  await native.sendOpen(sendOpen);
  await native.confirmOpen(rpc, 'saved-original-signature');
  await native.deliver(solanaOwner, 1, request, nativeChallenge, transport.send);
  await native.recoverDelivery(1, transport.recover);
  const close = await native.close(3, request, nativeChallenge, transport.send);
  if (close.state !== 'unknown') { const finality: false = close.chainSettled; void finality; }
  await native.confirmClose(rpc, 'saved-original-close-signature');
  await observeSolanaOpen(rpc, nativePlan, 'saved-original-signature');
  await observeSolanaClose(rpc, nativePlan, 'saved-original-close-signature');
  const initial: InitialObservation = await readInitialObservation(ledger);
  const saved: unknown = await ledger.get('unvalidated-row');
  // @ts-expect-error Unvalidated storage cannot be treated as trusted money data.
  saved.amount;
  // @ts-expect-error Native message authority is not an EVM typed-data signer.
  await base.prepareDeposit(solanaOwner);
  // @ts-expect-error EVM authority cannot sign native transactions.
  await native.signOpen(baseOwner, rpc);
  // @ts-expect-error Explicit request and challenge are mandatory.
  await base.deliver(baseOwner, 1, 'bodyhash', transport.send);
  // @ts-expect-error Recovery transport must return recoveryOnly:true.
  await native.recoverDelivery(1, async () => ({ status: 200, url: request.url, bodyText: '', headers: {}, requestDigest: '', authorizationDigest: '' }));
  // @ts-expect-error Caller cannot override the trusted observation clock.
  const bad: InitialObservation = { ...proof, now: 1 };
  // @ts-expect-error Legacy implicit voucher entry point accepts no payment arguments.
  await native.voucher(solanaOwner, 1, '1000', transport.send);
  const normalized: string = clone({ value: 1n }).value;
  const immutable = frozen({ nested: { value: 1n } });
  // @ts-expect-error Frozen policy helper is deeply readonly.
  immutable.nested.value = '2';
  atomic('1000'); canonical({ a: 1n }); digest({ a: 1n }); journalCanonical({ a: 1n }); exact({}, []); check(true);
  requestSnapshot(request, policy); fundingFresh(base); continuationFresh(native); callScope(native, 1, request);
  void [preparedAmount, zero, authorization, initial, normalized, bad];
  ledger.close();
}
void consumer;
