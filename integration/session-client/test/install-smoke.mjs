import {
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup } from "./fixtures.mjs";
const source = fileURLToPath(new URL("..", import.meta.url)),
  root = mkdtempSync(join(tmpdir(), "session-package-check-"));
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
  });
  if (result.status !== 0) throw Error(result.stdout + result.stderr);
  return result.stdout;
}
const real = Date.now;
try {
  let archive = process.argv[2] ? resolve(process.argv[2]) : undefined;
  if (!archive) {
    console.log(run("npm", ["pack", "--pack-destination", root], source));
    archive = join(root, "402signal-session-client-0.1.1.tgz");
  }
  const target = join(root, "installed");
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  console.log(
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive],
      target,
    ),
  );
  Date.now = () => 1800000000000;
  const fixtures = [];
  for (const rail of ["base", "solana"]) {
    const s = await setup(rail, 3);
    fixtures.push({
      rail,
      plan: s.plan,
      policy: s.policy,
      proof: s.proof,
      rawChallenge: s.rawChallenge,
    });
    s.ledger.close();
  }
  writeFileSync(join(target, "synthetic.json"), JSON.stringify(fixtures), {
    mode: 0o600,
  });
  copyFileSync(
    new URL("./install-case.mjs", import.meta.url),
    join(target, "installed.mjs"),
  );
  console.log(run(process.execPath, ["installed.mjs"], target));
} finally {
  Date.now = real;
  rmSync(root, { recursive: true, force: true });
}
