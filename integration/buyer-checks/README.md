# Test a buyer before it spends

This is an offline example for the exact x402 guard, using an existing synthetic Base fixture. It makes the acceptance and refusal boundaries visible without a funded wallet. It is not a hosted test endpoint or a conformance certification.

## Run the reference

From a reviewed checkout, with Node.js 22 or newer:

```sh
node integration/buyer-checks/run.mjs
node integration/buyer-checks/run.mjs --self-test
```

The first command reports seven named checks. A valid offer must reach the fake callback once with the expected network, asset, price and recipient. Changed price, recipient, request or expiry must refuse before that callback. The historical checks demonstrate that an original saved record verifies and changing its covered policy fails.

The self-test must detect a deliberately unguarded adapter and an adapter that always refuses. An implementation that stops every valid purchase is not a working buyer.

No account, service key, production clock or wallet is needed. Downloading source is a separate network operation. The default runner invokes the real verifier but does not make external requests, sign or send a payment. The public fixture key and clock are for tests only.

## Exercise your own boundary

```sh
node integration/buyer-checks/run.mjs --adapter ./integration/buyer-checks/example-adapter.mjs
```

Copy the example and connect the trusted verification boundary you want to test. Export `authorize(options, fakeCallback)`. Call only the supplied fake callback, after verification; never load a real wallet in this test. The adapter receives synthetic offer and receipt inputs and must throw on refusal.

The runner measures that callback. It cannot inspect undisclosed side effects in arbitrary code, establish the provenance of all transitive imports or sandbox a user-supplied module. Use an isolated environment without production credentials or external network access. A local adapter is code you explicitly trust and choose.

The report identifies the top-level adapter source hash and fixture hash. Record your full application/dependency revision separately. Successful reference tests do not establish that your application's signing path is wired correctly.

## Scope

Seven passing fixture checks do not establish successful seller payment, output quality, chain confirmation, Falcon anchor verification, native MPP coverage or session recovery. Use the documented suites for those mechanisms. This runner does not change payment behavior or the guard's error codes.

Human guide: https://402signal.com/developers#quickstart
Buyer integration: https://402signal.com/developers#route-binding
