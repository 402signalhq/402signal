# Test a buyer before it spends

For the separate reference lifecycle suites, run `node integration/buyer-checks/lifecycle.mjs routing` or read [observation-only onboarding](../reference-buyer/OBSERVE.md). These reports do not enlarge the five customer-adapter cases or certify customer signing code.

This is an offline example for the exact x402 guard, using an existing synthetic Base fixture. It makes the acceptance and refusal boundaries visible without a funded wallet. It is not a hosted test endpoint or a conformance certification.

## Run the reference

From a reviewed checkout, with Node.js 22 or newer:

```sh
node integration/buyer-checks/run.mjs
node integration/buyer-checks/run.mjs --self-test
```

The first command reports two separate suites: buyer adapter 5/5 and historical verifier 2/2. The report identifies each suite and its subject; the historical suite never tests your adapter. A valid offer must reach the fake callback once with the expected network, asset, price and recipient. Changed price, recipient, request or expiry must refuse before that callback. The historical checks demonstrate that an original saved record verifies and changing its covered policy fails.

The self-test must detect a deliberately unguarded adapter and an adapter that always refuses. An implementation that stops every valid purchase is not a working buyer.

No account, service key, production clock or wallet is needed. Downloading source is a separate network operation. The default runner invokes the real verifier but does not make external requests, sign or send a payment. The public fixture key and clock are for tests only.

## Exercise your own boundary

```sh
node integration/buyer-checks/run.mjs --adapter ./integration/buyer-checks/example-adapter.mjs
```

Copy the example and connect the trusted verification boundary you want to test. Export `authorize(options, fakeCallback)`. Call only the supplied fake callback, after verification; never load a real wallet in this test. The adapter receives synthetic offer and receipt inputs and must preserve the RouteGuardError from the guard on refusal. A generic exception is an adapter error, not a passing refusal. Do not translate initialization failures into guard errors.

The runner measures that callback. It cannot inspect undisclosed side effects in arbitrary code, establish the provenance of all transitive imports or sandbox a user-supplied module. Use an isolated environment without production credentials or external network access. A local adapter is code you explicitly trust and choose.

The report identifies the top-level adapter source hash and fixture hash. Record your full application/dependency revision separately. Successful reference tests do not establish that your application's signing path is wired correctly.

## Scope

Seven passing fixture checks do not establish successful seller payment, output quality, chain confirmation, Falcon anchor verification, native MPP coverage or session recovery. Use the documented suites for those mechanisms. This runner does not change payment behavior or the guard's error codes.

Human guide: https://402signal.com/developers#quickstart
Buyer integration: https://402signal.com/developers#route-binding

## Version 2 report and execution limits

The JSON report includes `report_version: "2"`, fixture and adapter hashes, separate `suites`, explicit `not_tested` mechanisms, expected and observed decisions, measured callback counts, safe reason codes and a debugging action. A default run identifies the reference boundary; neither it nor a synthetic customer-adapter run certifies a production signing integration.

The runner starts a separate worker with a 10-second execution limit. Worker stdout/stderr are suppressed and ordinary exception messages are never exported. Import/setup failures and timeouts produce `harness-error` with `incomplete: 1`, rather than a safety pass. Reports stay on stdout; there is no registration or telemetry. Save a report only when you choose to export it.

The worker receives no inherited application credentials or Node preload flags. This is not an operating-system sandbox or network firewall. A trusted adapter can still read accessible files, make network calls or create child processes. Use an isolated environment without production secrets and with external networking disabled; the timeout bounds this worker, not arbitrary descendants. The top-level source hash does not prove dependency integrity.

```sh
node --test integration/buyer-checks/report.test.mjs
```

This regression suite checks report separation, generic exceptions, import failure, unexpected logging, always-refusing and unguarded adapters, and a worker that never returns. None of these tests needs a wallet or payment.
