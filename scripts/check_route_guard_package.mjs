#!/usr/bin/env node
/** Qualify the installable artifact in a fresh consumer; no wallet/network calls.
 * CI installs the exact integration/lab lock first. A cloud checkout may reuse
 * that same pinned toolchain with --lab-node-modules=/absolute/node_modules.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'sdk/route-guard');
const arguments_ = process.argv.slice(2);
assert(arguments_.length <= 1 && arguments_.every(value => value.startsWith('--lab-node-modules=')),
  'usage: node scripts/check_route_guard_package.mjs [--lab-node-modules=/absolute/node_modules]');
const labModules = arguments_.length ? arguments_[0].slice('--lab-node-modules='.length) : join(root, 'integration/lab/node_modules');
assert(isAbsolute(labModules), 'lab node_modules path must be absolute');
const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const lab = await readJson(join(root, 'integration/lab/package.json'));
const typescript = await readJson(join(labModules, 'typescript/package.json'));
const nodeTypes = await readJson(join(labModules, '@types/node/package.json'));
assert.equal(typescript.version, lab.devDependencies.typescript, 'use the exact lab-pinned TypeScript');
assert.equal(nodeTypes.version, lab.devDependencies['@types/node'], 'use the exact lab-pinned Node types');
const metadata = await readJson(join(packageRoot, 'package.json'));
assert.equal(metadata.name, '@402signal/route-guard');
assert.deepEqual(metadata.dependencies ?? {}, {}, 'package consumer check must not fetch dependencies');
assert.deepEqual(metadata.optionalDependencies ?? {}, {}, 'package consumer check must not fetch optional dependencies');
assert.deepEqual(metadata.peerDependencies ?? {}, {}, 'package consumer check must not fetch peer dependencies');

const scratchParent = resolve(tmpdir());
const scratch = await fs.mkdtemp(join(scratchParent, 'signal-route-package-'));
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
  env: {...process.env, npm_config_update_notifier: 'false'},
});
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], packageRoot));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, metadata.name);
  assert.equal(packed[0].version, metadata.version);
  assert(typeof packed[0].filename === 'string' && !packed[0].filename.includes('/') && !packed[0].filename.includes('\\'));
  const tarball = join(scratch, packed[0].filename);
  const consumer = join(scratch, 'consumer');
  await fs.mkdir(consumer);
  await fs.writeFile(join(consumer, 'package.json'), JSON.stringify({name: 'route-guard-consumer-check', private: true, type: 'module'}));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);
  const installed = join(consumer, 'node_modules/@402signal/route-guard');
  assert.equal((await readJson(join(installed, 'package.json'))).version, metadata.version);

  const smoke = `
import assert from 'node:assert/strict';
globalThis.fetch = () => { throw new Error('package imports must not use network'); };
const exports = {
  '@402signal/route-guard': ['verifyReceipt', 'withVerifiedRoute', 'isUnsettledRouteMiss'],
  '@402signal/route-guard/recovery': ['reconcilePayment'],
  '@402signal/route-guard/client': ['RouteClient', 'RouteClientError', 'classifyRouteResponse'],
  '@402signal/route-guard/file-store': ['FileAttemptStore'],
  '@402signal/route-guard/batch': ['verifyBatchRoute', 'withVerifiedBatchRoute'],
};
for (const [specifier, names] of Object.entries(exports)) {
  const imported = await import(specifier);
  for (const name of names) assert.equal(typeof imported[name], 'function', specifier + ':' + name);
}
`;
  run(process.execPath, ['--input-type=module', '-e', smoke], consumer);
  await fs.writeFile(join(consumer, 'consumer.mts'), `
import {RouteClient, type RouteResult, type RouteResponse} from '@402signal/route-guard/client';
import {FileAttemptStore} from '@402signal/route-guard/file-store';
import {verifyReceipt, withVerifiedRoute} from '@402signal/route-guard';
import {reconcilePayment} from '@402signal/route-guard/recovery';
import {type BatchObservation} from '@402signal/route-guard/batch';
const nativeLimits:BatchObservation['buyer_limits']={fee_payer:null};
const nativeProfile:BatchObservation['profile']='algorand-mpp-charge-v1';
const invoiceProfile:BatchObservation['profile']='algorand-aggregate-invoice-v1';
void nativeLimits; void nativeProfile; void invoiceProfile;
const store = new FileAttemptStore('/tmp/typecheck-only-not-executed');
const client = new RouteClient({store, recoveryProfile: 'http-route-v1', customerKey: 'synthetic_customer_key_12345678901'});
const challenge: Promise<RouteResponse> = client.challenge('typecheck-only');
const outcome: Promise<RouteResult> = client.recover('typecheck-only');
const rawChallenge: Promise<string|null|undefined> = challenge.then(r => r.paymentRequired);
void rawChallenge; void challenge; void outcome; void verifyReceipt; void withVerifiedRoute; void reconcilePayment;
`);
  // Read the example from the installed tarball, never from the source tree.
  // This catches omitted package files as well as missing public declarations.
  await fs.copyFile(join(installed, 'examples/search.ts'), join(consumer, 'search.ts'));
  run(process.execPath, [join(labModules, 'typescript/bin/tsc'), '--outDir', 'build', '--strict',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
    '--lib', 'ES2022,DOM', '--types', 'node', '--typeRoots', join(labModules, '@types'),
    'consumer.mts', 'search.ts'], consumer);
  const exampleEvidence = JSON.parse(run(process.execPath, [join(root, 'scripts/check_search_example.mjs'),
    join(consumer, 'build/search.js'), installed], consumer));
  assert.equal(exampleEvidence.result, 'PASS');
  const tarballSha256 = createHash('sha256').update(await fs.readFile(tarball)).digest('hex');
  const capabilities = await readJson(join(root, 'live402/static/capabilities.json'));
  const pending = (capabilities.packages || []).find(
    (entry) => entry.tag === `route-guard-v${metadata.version}`,
  );
  if (pending && pending.state === 'pending') {
    assert.equal(pending.digest_status, 'provisional-until-release');
    assert.equal(pending.sha256, undefined, 'pending package must not claim a published sha256');
    assert.equal(pending.archive, undefined, 'pending package must not claim a published archive');
    assert.equal(pending.checksum_file, undefined);
    assert.equal(pending.published_at, undefined);
    assert.equal(pending.provisional_pack_sha256, tarballSha256);
  }
  console.log(JSON.stringify({result: 'PASS', package: metadata.name, version: metadata.version,
    tarballSha256,
    typescript: typescript.version, nodeTypes: nodeTypes.version, node: process.versions.node,
    checks: ['fresh offline tarball install', 'all public runtime entrypoints',
      'strict NodeNext client and FileAttemptStore declarations', 'packaged search example',
      'executable packaged search example with synthetic buyer and transport'],
    exampleEvidence,
    packagePublished: false, paymentOrMerchantCalls: 0}, null, 2));
} finally {
  assert.equal(dirname(scratch), scratchParent);
  assert(scratch.startsWith(join(scratchParent, 'signal-route-package-')));
  await fs.rm(scratch, {recursive: true, force: true});
}
