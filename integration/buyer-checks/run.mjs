/** Bounded diagnostic worker. This is process isolation, not a sandbox. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const valid = args.length === 0 || (args.length === 1 && args[0] === '--self-test')
  || (args.length === 2 && args[0] === '--adapter');
function failure(reason) {
  console.log(JSON.stringify({ report_version: '2', mode: 'synthetic-fixtures',
    test_outcome: 'harness-error', reason_code: reason, passed: 0, failed: 0,
    incomplete: 1, next_action: 'check_trusted_adapter_and_fixture_setup_without_exporting_secrets' }, null, 2));
  process.exitCode = 1;
}
if (!valid) failure('invalid_arguments');
else {
  const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), args, {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  let report = null, timedOut = false, finished = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
  child.on('message', value => { report = value; });
  const finish = (code) => {
    if (finished) return; finished = true; clearTimeout(timer);
    if (timedOut) return failure('worker_timeout');
    if (!report || ![0, 1].includes(code)) return failure('worker_setup_or_execution_error');
    console.log(JSON.stringify(report, null, 2));
    if (code !== 0 || report.failed) process.exitCode = 1;
  };
  child.on('error', () => finish(null));
  child.on('exit', finish);
}
