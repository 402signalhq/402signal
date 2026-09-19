# Session client

An opt-in buyer client for longer Base x402 batch-settlement channels and native
Solana MPP push sessions. It separates the initial API observation from the
buyer's decision to keep using an already funded session.

The current version supports 1–64 sequential calls and a fixed buyer deadline of
up to 24hours. Synthetic qualification covers 3, 10 and 64calls over two hours,
including process restart and lost responses. These are client bounds, not chain
throughput limits or a promise of merchant availability. Live qualification of
this continuation version is separate from the earlier two-call lab tests.

## What stays fixed

- The original signed 402Signal observation, complete request and response, and
  its expiry remain in the buyer's private journal. A later merchant challenge
  does not refresh that observation or generate a 402Signal routing charge.
- The buyer pins one HTTPS endpoint, chain, asset, parties, channel, per-call
  price, total authorized amount, call count and deadline before funding.
- A continuation call can authorize another cumulative voucher within that
  policy. It cannot create a deposit, top-up, new routing payment or fee refresh.
- Signing and sending require separate durable claims. An uncertain result
  stops later calls. Restart cannot issue the same authority again.

The buyer supplies wallet callbacks; keys stay with the buyer. A successful
voucher receipt acknowledges an off-chain payment authorization. It is not
final chain settlement or a guarantee that an API delivered useful work.

## Install and runtime

Install a reviewed package archive with `npm install ./402signal-session-client-0.1.1.tgz`.
The archive includes the guard and funding/settlement primitives it uses; an
installed customer does not need the 402Signal repository or lab checkout.
`PROVENANCE.json` records the copied source hashes. Node24 is required.

The bundled `LocalBatchLedger` uses private, synchronous SQLite storage on a
POSIX filesystem. Use Linux/macOS or WSL; keep the directory 0700 and files 0600.
One durable ledger identity owns one immutable session. Multiple connections
coordinate through atomic claims. Do not copy or delete a journal to retry an
uncertain payment. A different storage adapter must implement the same durable
`bind`, `once`, `get`, `require` and compare-and-swap `transition` contract.

## Authorize a continuation policy

All amounts below are integer USDC atomic units: 1000 is $0.001. The native MPP
`minVoucherDelta` is a protocol minimum, not a quoted price. Obtain the merchant's
actual per-call price independently and pin it explicitly.

```js
import { LocalBatchLedger } from "@402signal/session-client/ledger";
import { SolanaSessionClient } from "@402signal/session-client/solana";
import { createSessionTransport } from "@402signal/session-client/transport";

const policy = {
  version: 2,
  maxCalls: 10,
  perCallAtomic: "1000",
  maxCumulativeAtomic: "10000",
  expiresAt: fixedBuyerDeadlineMilliseconds,
  request: { url: merchantUrl, method: "GET", maxBodyBytes: 0 },
};
const ledger = new LocalBatchLedger(privateDirectory, uniqueSessionId);
const client = new SolanaSessionClient(ledger, reviewedOpeningPlan, {
  policy,
  initialObservation: {
    routeResponseJson,
    routeRequestJson,
    trustedLogVkey,
    challenge: {
      status: 402,
      bodyText: "",
      paymentRequired: null,
      wwwAuthenticate,
    },
  },
});
await client.initialize(); // Verifies the signed observation before funding.
```

`reviewedOpeningPlan` comes from the exported `prepareSolanaSession` function.
Its explicit buyer policy includes payer/operator/recipient, program-data hash,
deposit, native-cost cap, salt and voucher expiry. The exported
`quoteSolanaSessionRent` and `verifySolanaSessionDeployment` helpers support
read-only preflight. Keep the existing one-shot `signOpen`, `sendOpen` and
`confirmOpen` sequence: only a finalized, fully checked opening enables calls.
An ordinary merchant may also require registration of that original complete
opening transaction. Funding must be authorized while the original observation
is fresh; later finality confirmation does not require another routing fee.

For Base, construct `BaseSessionClient(ledger, operationJournal, readonlyRpc,
reviewedBasePlan, { policy, initialObservation })` from the `/base` export.
`LocalOperationJournal` is available from `/ledger`. The Base plan pins channel
configuration, deployment code hashes, deposit, price/count, expiry and buyer gas
cap. Keep the existing `prepareDeposit`, `sendDeposit` and finalized
`confirm('deposit')` sequence. Continued calls use the original funded channel.

## Send a call and recover safely

```js
const transport = createSessionTransport({
  // Optional: your merchant's genuinely read-only stored-receipt lookup.
  // It receives only channel/sequence and request/authorization hashes.
  readReceipt: lookupStoredReceipt,
});
const request = { url: merchantUrl, method: "GET", body: "" };
const result = await client.deliver(
  buyerSigner,
  nextSequence,
  request,
  currentOrdinaryMerchantChallenge,
  transport.send,
);
if (result.state === "unknown") {
  const recovered = await client.recoverDelivery(
    nextSequence,
    transport.recover,
  );
  // Continue only when recovered.state === 'voucher_accepted'.
}
```

For Solana the challenge argument is the current `WWW-Authenticate` header.
For Base it is the current raw x402 JSON challenge body. Fetch challenges under
your own request policy. The client never fetches or refreshes one automatically.
Solana allows a fresh ID, expiry and recent block information while requiring the
same economic terms. Receipts are checked against the exact channel and new
cumulative amount using the pinned SDK's standard acknowledgment fields.

The default sender preserves exact request bytes, refuses redirects and retries,
omits ambient credentials, and bounds response storage. Custom transports are
trusted buyer code and must preserve these properties. There is no default
recovery network request: sending a live voucher again with a header such as
`Replay-Only` is unsafe unless the merchant actually implements that contract.
Without a verifiable stored receipt, the call remains uncertain and fenced.

`readReceipt` must return the original normalized response:
`{ status, url, requestDigest, authorizationDigest, bodyText, headers }`.
Headers use lowercase keys. `transport.recover` marks it as a read-only result;
the controller checks both digests and the standard cumulative receipt. At most
six explicit recovery reads are allowed per call; none can sign or send a voucher.

On restart, use the same journal, plan and policy. `initialObservation` may be
omitted: the complete original proof is reconstructed from private storage.
The old observation remains historical, rather than being treated as fresh.

## Finish the existing session

Base retains the original `close(sequence)`, claim/settle, finalized confirmation
and unused-refund operations. A voucher receipt alone never closes the ledger.

Native `close(sequence, request, currentChallenge, transport.send)` sends the
existing highest accepted voucher with a fresh ordinary merchant challenge. It
creates no new buyer signature. A merchant may acknowledge only the close
request; `close_requested` is not settlement. Obtain the original settlement
transaction from the merchant/operator and call `confirmClose(readonlyRpc,
signature)`. The unchanged observer verifies the complete finalized transaction,
merchant amount, buyer refund and channel state. Cleanup can continue after the
buyer's call deadline, within the original voucher's settlement window.

## Request and compatibility limits

GET has no body. An explicit local POST policy accepts at most 4096 UTF-8 bytes of
strict JSON, preserving the original whitespace and rejecting duplicate keys.
This is buyer-local request control. It does not claim that a voucher
cryptographically binds every body byte or that a merchant enforces this policy.
It does not broaden the hosted 402Signal probe profiles or POST support.

The Solana deadline must leave the original 900-second settlement window.
Push sessions only: no pull delegation, automatic top-up, cross-channel batching,
or universal MPP support. Base means x402 batch settlement, not all EVM payments.
Higher call counts require a separately reviewed version; the current 64-call
limit is an intentional controller qualification bound.

## Maintainer qualification

In the cloud checkout, install lab dependencies and run `npm run build` here,
then `npm test` and `npm run test:package`. The latter installs the archive in a
clean directory and exercises both public clients. `npm pack` refreshes the unchanged internal primitives and their
provenance. Tests use synthetic signing keys and receipts, including an actual
native SDK server and a 3-call lab HTTP path with finalized-effect fixtures.
The private funding fixtures used by the volume tests are labeled as fixtures;
they are not evidence of a new live payment campaign.


### Base receiver reuse and concurrent channels

A fresh Base channel may reuse a receiver whose earlier claims are fully paid. Channel-local balance, claimed amount, withdrawal fields and refund nonce must still be zero; the receiver's cumulative claimed and settled counters may be equal and nonzero. The controller retains those exact historical values as its baseline. Reopening a campaign never resets that baseline or creates another send permit.

This owner controller still serializes activity for a receiver/token pair. An outstanding receiver payout is refused at initialization, and unrelated receiver activity between operation baselines or within an observed block leaves confirmation unknown. Do not retry an economic operation to resolve that uncertainty. Finalized receipts, exact channel effects, receiver deltas, refund nonce and token-transfer accounting remain required. This is a bounded qualification workflow, not a high-throughput multi-channel settlement coordinator.

General concurrent receiver support requires separate receiver-level claim/settlement coordination and durable per-channel allocation: the contract's `settle(receiver, token)` pays the receiver-wide outstanding total. Per-channel receipt checks cannot simply treat another channel's payout as this campaign's revenue. No concurrency relaxation or additional authority is included here.
