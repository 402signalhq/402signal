/** Customer fixture checks. No wallet, signing account or live transport is supplied. */
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { withVerifiedRoute, verifyReceipt, RouteGuardError } from '../../sdk/route-guard/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureBytes = await readFile(resolve(root, 'tests/fixtures/route-binding-v1.json'));
const fixtures = JSON.parse(fixtureBytes.toString('utf8'));
if (fixtures.test_only !== true) throw new Error('Only explicit test fixtures are permitted');
const sample = fixtures.cases.find(item => item.rail === 'base' && item.method === 'GET');
if (!sample) throw new Error('Missing Base GET fixture');
const reference = async (options, callback) => withVerifiedRoute(options, callback);
const args = process.argv.slice(2);
let adapter = reference, subject = '402signal-reference-boundary';
if (args.length && args[0] !== '--self-test') {
  if (args.length !== 2 || args[0] !== '--adapter') throw new Error('Usage: node run.mjs [--adapter trusted-local-module.mjs | --self-test]');
  const path = await realpath(resolve(args[1]));
  const source = await readFile(path);
  if (source.length > 262144) throw new Error('Adapter module is too large');
  // Explicitly selected local code is trusted, not sandboxed. No remote module loader.
  const supplied = await import(pathToFileURL(path).href);
  if (typeof supplied.authorize !== 'function') throw new Error('Adapter must export authorize(options, fakeCallback)');
  adapter = supplied.authorize;
  subject = 'customer-adapter-sha256:' + createHash('sha256').update(source).digest('hex');
} else if (args.length > 1) throw new Error('Unexpected arguments');

function optionsFor() {
  return {
    routeResponseJson: JSON.stringify(sample.response),
    routeRequestJson: JSON.stringify(sample.request),
    trustedLogVkey: fixtures.trusted_vkey,
    request: { url: sample.response.url, method: sample.method, body: Buffer.from(sample.body) },
    challenge: { status: 402, bodyText: JSON.stringify(sample.challenge) },
    now: sample.now, // PUBLIC TEST KEY and fixture clock only. Never use in production.
  };
}
const scenarios = [
  ['matching-offer', 1, options => options],
  ['price-changed', 0, options => {
    const current = JSON.parse(options.challenge.bodyText);
    current.accepts[0].amount = '30000';
    return { ...options, challenge: { status: 402, bodyText: JSON.stringify(current) } };
  }],
  ['recipient-changed', 0, options => {
    const current = JSON.parse(options.challenge.bodyText);
    current.accepts[0].payTo = '0x1111111111111111111111111111111111111111';
    return { ...options, challenge: { status: 402, bodyText: JSON.stringify(current) } };
  }],
  ['evidence-expired', 0, options => ({ ...options, now: sample.response.decision_binding.expires_at + 1 })],
  ['original-request-changed', 0, options => ({ ...options, routeRequestJson: JSON.stringify({ ...sample.request, max_price_usd: 0.20 }) })],
];
async function runBoundary(subjectName, authorize) {
  const results = [];
  for (const [scenario, expected, change] of scenarios) {
    let calls = 0, rejected = false, callbackTermsMatch = true, reason = null;
    let expectedReason = null;
    if (!expected) {
      try { await reference(change(optionsFor()), async () => { throw new Error('fixture unexpectedly accepted'); }); }
      catch (error) { if (error instanceof RouteGuardError) expectedReason = error.code; }
      if (!expectedReason) throw new Error('broken refusal fixture');
    }
    const fakeCallback = async verified => {
      calls++;
      callbackTermsMatch = Boolean(verified && verified.accepted
        && verified.accepted.payTo === sample.challenge.accepts[0].payTo
        && verified.accepted.amount === sample.challenge.accepts[0].amount
        && verified.accepted.network === sample.challenge.accepts[0].network
        && verified.accepted.asset === sample.challenge.accepts[0].asset);
      return { synthetic: true };
    };
    try { await authorize(change(optionsFor()), fakeCallback); }
    catch (error) {
      rejected = true;
      // Never echo arbitrary exception messages, paths, requests or payment headers.
      reason = error instanceof RouteGuardError && error.code === expectedReason
        ? error.code : 'unexpected_adapter_exception';
    }
    const pass = calls === expected && (expected === 1 ? !rejected && callbackTermsMatch : rejected && reason === expectedReason);
    results.push({
      subject: subjectName, scenario, suite: 'buyer-adapter',
      observed_decision: calls ? 'authorization_callback_reached' : (reason === 'unexpected_adapter_exception' ? 'adapter_error' : rejected ? 'refused' : 'returned_without_authorization'),
      reason_code: reason,
      expected_reason_code: expectedReason,
      next_action: pass ? 'none' : reason === 'unexpected_adapter_exception' ? 'check_adapter_initialization_and_preserve_guard_errors' : 'inspect_verification_boundary_and_callback_wiring',
      measured_callback_terms_match: callbackTermsMatch,
      expected_decision: expected ? 'invoke_fake_authorization_once' : 'refuse_before_authorization',
      observed_authorization_calls: calls,
      observed_rejection: rejected,
      test_outcome: pass ? 'passed' : 'failed',
    });
  }
  return results;
}
function historicalCases() {
  const original = optionsFor();
  let valid = false;
  try { verifyReceipt(original); valid = true; } catch {}
  const changed = structuredClone(sample.response);
  const evidence = changed.pq_trust.transparency.reveal.evidence;
  const request = JSON.parse(evidence.request_json);
  request.max_price_usd = 0.20;
  evidence.request_json = JSON.stringify(request);
  let refused = false;
  try { verifyReceipt({ ...original, routeResponseJson: JSON.stringify(changed) }); } catch { refused = true; }
  return [
    { suite: 'historical-verifier', subject: '402signal-historical-verifier', scenario: 'original-saved-record', test_outcome: valid ? 'passed' : 'failed' },
    { suite: 'historical-verifier', subject: '402signal-historical-verifier', scenario: 'saved-policy-altered', test_outcome: refused ? 'passed' : 'failed' },
  ];
}
let cases;
if (args[0] === '--self-test') {
  const good = await runBoundary(subject, reference);
  const unguarded = await runBoundary('deliberately-unguarded', async (options, callback) => {
    await callback({ accepted: JSON.parse(options.challenge.bodyText).accepts[0] });
  });
  const brokenOnRefusal = await runBoundary('deliberately-broken-on-refusal', async (options, callback) => {
    try { return await reference(options, callback); }
    catch { throw new Error('SECRET_MUST_NOT_APPEAR'); }
  });
  const refusesEverything = await runBoundary('deliberately-always-refuses', async () => { throw Error('stopped'); });
  cases = [
    { scenario: 'reference-passes', test_outcome: good.every(r => r.test_outcome === 'passed') ? 'passed' : 'failed' },
    { scenario: 'detect-unexpected-exceptions', test_outcome: brokenOnRefusal.filter(r => r.test_outcome === 'failed').length === 4 ? 'passed' : 'failed' },
    { scenario: 'detect-unguarded-adapter', test_outcome: unguarded.some(r => r.test_outcome === 'failed') ? 'passed' : 'failed' },
    { scenario: 'detect-always-refusing-adapter', test_outcome: refusesEverything.some(r => r.test_outcome === 'failed') ? 'passed' : 'failed' },
    ...historicalCases(),
  ];
} else cases = [...await runBoundary(subject, adapter), ...historicalCases()];
const failed = cases.filter(item => item.test_outcome === 'failed').length;
process.send({
  report_version: '2',
  subject_version: 'Record your reviewed application and dependency revisions separately.',
  customer_signing_integration_tested: false,
  report_kind: args[0] === '--self-test' ? 'harness-self-test' : 'boundary-fixtures',
  suites: ['buyer-adapter', 'historical-verifier'].map(suite => {
    const members = cases.filter(c => c.suite === suite);
    return { suite, passed: members.filter(c => c.test_outcome === 'passed').length,
      failed: members.filter(c => c.test_outcome !== 'passed').length, total: members.length,
      subject: suite === 'buyer-adapter' ? subject : '402signal-historical-verifier' };
  }),
  not_tested: ['merchant-settlement', 'response-recovery', 'native-mpp', 'session-continuation', 'falcon-anchors', 'production-signing-integration'], mode: 'synthetic-fixtures', profile: 'exact-x402-base-fixture',
  fixture_sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  subject, passed: cases.length - failed, failed, cases,
  scope: 'Tests the supplied fake authorization callback and historical verifier. No wallet is supplied. Customer adapter code is trusted, not sandboxed. This does not test all payment mechanisms, a merchant, an anchor or production settlement.',
});
if (failed) process.exitCode = 1;
