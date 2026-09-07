#!/usr/bin/env node
// Owner-operated POSIX CLI. Plan does not import wallet hooks or open a journal.
import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strictJson } from "../../reference-buyer/policy.mjs";
import {
  AlgorandBatchCampaign,
  planAlgorandBatchCampaign,
} from "./campaign-operator.mjs";
const fail = () => {
  throw new Error(
    "Usage: owner-cli.mjs plan POLICY | run|recover POLICY PRIVATE_JOURNAL JOB OWNER_HOOKS_MODULE",
  );
};
const [command, policyPath, directory, id, hookPath, ...extra] =
  process.argv.slice(2);
let campaign, hooks;
try {
  if (
    extra.length ||
    !["plan", "run", "recover"].includes(command) ||
    !policyPath
  )
    fail();
  const st = lstatSync(policyPath);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16384)
    throw new Error("policy_file_refused");
  const policy = strictJson(readFileSync(policyPath, "utf8"), 16384);
  if (command === "plan") {
    if (directory || id || hookPath) fail();
    console.log(JSON.stringify(planAlgorandBatchCampaign(policy), null, 2));
  } else {
    if (!directory || !id || !hookPath) fail();
    if (
      command === "run" &&
      process.env.ALGORAND_BATCH_CAMPAIGN_ACK !==
        "reviewed-mainnet-5000-atomic-v1"
    )
      throw new Error("explicit_campaign_ack_required");
    // Validate immutable policy and journal before loading owner-provided callbacks.
    campaign = new AlgorandBatchCampaign(directory, policy);
    const module = await import(pathToFileURL(resolve(hookPath)).href);
    hooks =
      command === "run"
        ? await module.createRunHooks(policy, { directory, id })
        : await module.createReadOnlyRecoveryHooks(policy, { directory, id });
    const outcome = await campaign[command](id, hooks);
    if (
      command === "recover" &&
      outcome.stage === "router_or_proof" &&
      typeof hooks.recoverRouter === "function"
    ) {
      outcome.routerRecovery = await hooks.recoverRouter();
    }
    console.log(JSON.stringify(outcome, null, 2));
  }
} catch (error) {
  console.error(
    "algorand_campaign_stopped; use read-only recovery and private evidence",
  );
  process.exitCode = 1;
} finally {
  hooks?.close?.();
  campaign?.close();
}
