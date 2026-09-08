#!/usr/bin/env node
import { readFileSync, lstatSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { strictJson, canonical, check } from "../../reference-buyer/policy.mjs";
import { ManifestOwnerCampaign } from "./manifest-owner.mjs";
const sha = (x) => createHash("sha256").update(x).digest("hex");
function read(path, max = 65536) {
  const s = lstatSync(path);
  check(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid() &&
      s.nlink === 1 &&
      s.size <= max,
    "private_file_refused",
  );
  return readFileSync(path);
}
export async function runManifestOwnerCLI(argv, { env = process.env } = {}) {
  check(argv.length === 4, "usage_refused");
  const [stage, configPath, pinsPath, directory] = argv;
  check(
    ["plan", "run", "route", "deliver", "recover", "status"].includes(stage),
    "stage_refused",
  );
  const c = strictJson(read(resolve(configPath)).toString()),
    pins = strictJson(read(resolve(pinsPath)).toString());
  check(
    c.releasePinsSha256 === sha(canonical(pins) + "\n") &&
      c.sourceCommit === pins.sourceCommit &&
      c.sourceTree === pins.sourceTree,
    "source_pins_changed",
  );
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const mandatory = [
    "integration/batch-buyer/algorand/manifest-owner.mjs",
    "integration/batch-buyer/algorand/manifest-owner-factory.mjs",
    "integration/batch-buyer/algorand/manifest-owner-cli.mjs",
    "integration/batch-buyer/algorand/owner-hooks.mjs",
    "integration/batch-buyer/algorand/manifest.mjs",
    "integration/batch-buyer/algorand/manifest-store.mjs",
    "sdk/route-guard/batch.mjs",
    "sdk/route-guard/client.mjs",
    "sdk/route-guard/file-store.mjs",
  ];
  check(
    pins.files &&
      mandatory.every((f) => Object.hasOwn(pins.files, f)) &&
      Object.keys(pins.files).length <= 64,
    "source_pins_required",
  );
  for (const [f, h] of Object.entries(pins.files)) {
    const target = resolve(root, f);
    check(
      !relative(root, target).startsWith("..") &&
        /^[0-9a-f]{64}$/.test(h) &&
        sha(read(target, 2000000)) === h,
      "source_changed",
    );
  }
  let owner;
  if (["run", "route", "deliver"].includes(stage)) {
    check(
      env.LAB_MANIFEST_OWNER_ACK === "reviewed-fresh-group3-or-invoice3-6000",
      "owner_ack_required",
    );
    owner = (await import("./manifest-owner-factory.mjs")).createManifestOwner(
      c,
      env,
    );
  }
  const campaign = new ManifestOwnerCampaign(directory, c, { owner });
  try {
    return stage === "plan" || stage === "status"
      ? campaign.status()
      : await campaign[stage]();
  } finally {
    campaign.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(await runManifestOwnerCLI(process.argv.slice(2))),
    );
  } catch {
    console.log(
      JSON.stringify({
        state: "stopped_review_retained_journal",
        newPaymentAllowed: false,
      }),
    );
    process.exitCode = 1;
  }
}
