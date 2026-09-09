import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const run = fileURLToPath(new URL('./run.mjs', import.meta.url));
function invoke(args = []) {
  const p = spawnSync(process.execPath, [run, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(p.error, undefined); assert.equal(p.stderr, '');
  assert.ok(!p.stdout.includes('SECRET_MUST_NOT_APPEAR'));
  return { status: p.status, report: JSON.parse(p.stdout) };
}
test('separate measured suites and explicit limits', () => {
  const { status, report } = invoke(); assert.equal(status, 0); assert.equal(report.report_version, '2');
  assert.deepEqual(report.suites.map(s => [s.suite, s.passed, s.total]), [['buyer-adapter', 5, 5], ['historical-verifier', 2, 2]]);
  assert.equal(report.customer_signing_integration_tested, false); assert.ok(report.not_tested.includes('response-recovery'));
  assert.equal(report.cases[0].observed_authorization_calls, 1);
  for (const c of report.cases.slice(1, 5)) { assert.equal(c.observed_authorization_calls, 0); assert.equal(c.reason_code, c.expected_reason_code); }
});
test('self-test rejects generic errors, no guard, and universal refusal', () => {
  const { status, report } = invoke(['--self-test']); assert.equal(status, 0);
  for (const name of ['detect-unexpected-exceptions', 'detect-unguarded-adapter', 'detect-always-refusing-adapter'])
    assert.equal(report.cases.find(c => c.scenario === name).test_outcome, 'passed');
});
test('setup failure, logging and timeout cannot claim safety', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyer-report-'));
  try {
    for (const [name, src, reason] of [
      ['import', "throw new Error('SECRET_MUST_NOT_APPEAR')", 'worker_setup_or_execution_error'],
      ['loop', 'while (true) {}', 'worker_timeout'],
    ]) {
      const path = join(dir, name + '.mjs'); writeFileSync(path, src);
      const { status, report } = invoke(['--adapter', path]); assert.equal(status, 1); assert.equal(report.reason_code, reason); assert.equal(report.test_outcome, 'harness-error'); assert.equal(report.incomplete, 1);
    }
    const path = join(dir, 'logs.mjs'); writeFileSync(path, "console.log('SECRET_MUST_NOT_APPEAR'); console.error('SECRET_MUST_NOT_APPEAR'); export async function authorize(){ throw new Error('SECRET_MUST_NOT_APPEAR'); }");
    const { status, report } = invoke(['--adapter', path]); assert.equal(status, 1);
    assert.equal(report.suites[0].failed, 5); assert.equal(report.suites[1].passed, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
