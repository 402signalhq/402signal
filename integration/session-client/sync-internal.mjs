import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  readdir,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const here = dirname(fileURLToPath(import.meta.url)),
  repo = resolve(here, "../..");
execFileSync("npm", ["run", "build"], {
  cwd: resolve(repo, "integration/lab"),
  stdio: "inherit",
});
const sha = (b) => createHash("sha256").update(b).digest("hex"),
  sources = {};
async function copy(from, to, transform = (x) => x) {
  const raw = await readFile(resolve(repo, from));
  const value = transform(raw.toString());
  await mkdir(dirname(resolve(here, to)), { recursive: true });
  await writeFile(resolve(here, to), value);
  sources[to] = {
    source: from,
    sourceSha256: sha(raw),
    packagedSha256: sha(value),
  };
}
for (const name of [
  "base-batch-lifecycle",
  "base-batch-observer",
  "base-batch-ledger",
  "batch-schema-readiness",
  "batch-operation-journal",
  "batch-operation-runner",
])
  await copy(`integration/lab/dist/src/${name}.js`, `internal/${name}.js`);
await copy(
  "integration/lab/owner-runtime/local-ledger.mjs",
  "internal/local-ledger.mjs",
);
await copy(
  "integration/lab/solana-session-contracts/src/owner-session.mjs",
  "internal/native-v1.mjs",
  (x) =>
    x.replace(
      "../../sdk/route-guard/internal-json.mjs",
      "../route-guard/internal-json.mjs",
    ),
);
for (const dir of ["", "/batch-profiles"])
  for (const name of await readdir(resolve(repo, "sdk/route-guard" + dir)))
    if (name.endsWith(".mjs"))
      await copy(
        "sdk/route-guard" + dir + "/" + name,
        "route-guard" + dir + "/" + name,
      );
await writeFile(
  resolve(here, "PROVENANCE.json"),
  JSON.stringify(
    {
      version: 1,
      generatedFrom:
        "unchanged repository primitives; only native parser import path adjusted",
      files: sources,
    },
    null,
    2,
  ),
);
