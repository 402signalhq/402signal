import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
const lab = new URL("../../lab/", import.meta.url);
execFileSync("npm", ["run", "build"], {
  cwd: fileURLToPath(lab),
  stdio: "inherit",
});
for (const [input, output] of [
  ["algorand-batch.js", "index.mjs"],
  ["algorand-batch-policy.js", "policy.mjs"],
  ["json.js", "json.mjs"],
  ["algorand-manifest.js", "manifest.mjs"],
  ["algorand-manifest-store.js", "manifest-store.mjs"],
]) {
  const text = readFileSync(new URL("dist/src/" + input, lab), "utf8")
    .replaceAll("./algorand-batch-policy.js", "./policy.mjs")
    .replaceAll(
      "../../sdk/route-guard/batch-profiles/algorand-generic.mjs",
      "./generic-profile.mjs",
    )
    .replaceAll("./json.js", "./json.mjs")
    .replaceAll("./algorand-manifest-store.js", "./manifest-store.mjs")
    .replaceAll(
      "../../sdk/route-guard/batch-profiles/algorand-manifest.mjs",
      "./manifest-profile.mjs",
    );
  writeFileSync(new URL(output, import.meta.url), text);
}
copyFileSync(
  new URL("../../LICENSE", lab),
  new URL("LICENSE", import.meta.url),
);

copyFileSync(
  new URL(
    "../../../sdk/route-guard/batch-profiles/algorand-generic.mjs",
    import.meta.url,
  ),
  new URL("generic-profile.mjs", import.meta.url),
);

copyFileSync(
  new URL(
    "../../../sdk/route-guard/batch-profiles/algorand-manifest.mjs",
    import.meta.url,
  ),
  new URL("manifest-profile.mjs", import.meta.url),
);

const declarations = mkdtempSync(join(tmpdir(), "algorand-manifest-types-"));
try {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("node_modules/typescript/bin/tsc", lab)),
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      declarations,
    ],
    { cwd: fileURLToPath(lab), stdio: "inherit" },
  );
  for (const [source, target] of [
    ["algorand-manifest", "manifest"],
    ["algorand-manifest-store", "manifest-store"],
  ]) {
    const text = readFileSync(
      join(declarations, "src", source + ".d.ts"),
      "utf8",
    )
      .replaceAll("./algorand-manifest-store.js", "./manifest-store.mjs")
      .replace(
        'import { checkAlgorandBatchGroup } from "./algorand-batch-policy.js";',
        'import type { Group } from "./index.mjs";',
      )
      .replaceAll("ReturnType<typeof checkAlgorandBatchGroup>", "Group");
    writeFileSync(new URL(target + ".d.ts", import.meta.url), text);
  }
} finally {
  rmSync(declarations, { recursive: true, force: true });
}
