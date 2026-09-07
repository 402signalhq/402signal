import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const lab = new URL("../../lab/", import.meta.url);
execFileSync("npm", ["run", "build"], {
  cwd: fileURLToPath(lab),
  stdio: "inherit",
});
for (const [input, output] of [
  ["algorand-batch.js", "index.mjs"],
  ["algorand-batch-policy.js", "policy.mjs"],
  ["json.js", "json.mjs"],
]) {
  const text = readFileSync(new URL("dist/src/" + input, lab), "utf8")
    .replaceAll("./algorand-batch-policy.js", "./policy.mjs")
    .replaceAll(
      "../../sdk/route-guard/batch-profiles/algorand-generic.mjs",
      "./generic-profile.mjs",
    )
    .replaceAll("./json.js", "./json.mjs");
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
