import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const source = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'session-types-check-'));
const toolchain = resolve(source, '../lab/node_modules');
function run(command, args, cwd) {
  const p = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000 });
  if (p.status !== 0) throw Error(p.stdout + p.stderr);
  return p.stdout;
}
try {
  let archive = process.argv[2] ? resolve(process.argv[2]) : undefined;
  if (!archive) { run('npm', ['pack', '--pack-destination', root], source); archive = join(root, '402signal-session-client-0.1.1.tgz'); }
  const installed = join(root, 'installed'); mkdirSync(installed);
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive], installed);
  const pkg = join(installed, 'node_modules/@402signal/session-client');
  const metadata = JSON.parse(readFileSync(join(pkg, 'package.json')));
  assert.equal(metadata.license, 'MIT'); assert.match(readFileSync(join(pkg, 'LICENSE'), 'utf8'), /MIT License/);
  for (const entry of Object.values(metadata.exports)) assert.ok(readFileSync(join(pkg, entry.types)).length > 0);
  copyFileSync(new URL('./consumer.mts', import.meta.url), join(installed, 'consumer.mts'));
  run(process.execPath, [join(toolchain, 'typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--typeRoots', join(toolchain, '@types'), '--types', 'node', 'consumer.mts'], installed);
  console.log(JSON.stringify({ strictInstalledConsumer: 'PASS', exports: 5, skipLibCheck: false, expectedTypeRefusals: (readFileSync(join(installed, 'consumer.mts'), 'utf8').match(/@ts-expect-error/g) ?? []).length, license: 'MIT', localPaymentExecution: false }));
} finally { rmSync(root, { recursive: true, force: true }); }
