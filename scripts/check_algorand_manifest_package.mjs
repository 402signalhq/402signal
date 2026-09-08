#!/usr/bin/env node
/** Offline packed-consumer check using the exact already-installed lab locks. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  lab = join(root, "integration/lab"),
  modules = join(lab, "node_modules"),
  scratch = mkdtempSync(join(tmpdir(), "algorand-manifest-consumer-"));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
try {
  const consumer = join(scratch, "consumer");
  mkdirSync(join(consumer, "node_modules/@402signal"), { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  for (const [dir, name] of [
    ["sdk/route-guard", "route-guard"],
    ["integration/batch-buyer/algorand", "algorand-batch-buyer"],
  ]) {
    const metadata = JSON.parse(
      readFileSync(join(root, dir, "package.json"), "utf8"),
    );
    for (const [dependency, version] of Object.entries(
      metadata.dependencies ?? {},
    ))
      assert.equal(
        JSON.parse(
          readFileSync(join(modules, dependency, "package.json"), "utf8"),
        ).version,
        version,
      );
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
        join(root, dir),
      ),
    )[0];
    const target = join(consumer, "node_modules/@402signal", name);
    mkdirSync(target);
    run(
      "tar",
      [
        "-xzf",
        join(scratch, packed.filename),
        "--strip-components=1",
        "-C",
        target,
      ],
      scratch,
    );
  }
  for (const scope of ["@algorandfoundation", "@x402", "@types"])
    symlinkSync(
      join(modules, scope),
      join(consumer, "node_modules", scope),
      "dir",
    );
  const installed = join(
    consumer,
    "node_modules/@402signal/algorand-batch-buyer",
  );
  cpSync(join(installed, "examples/manifest.ts"), join(consumer, "example.ts"));
  writeFileSync(
    join(consumer, "check.ts"),
    `import {prepareAlgorandManifest, type AlgorandManifestPlan} from '@402signal/algorand-batch-buyer/manifest';\nimport {AlgorandManifestStore} from '@402signal/algorand-batch-buyer/manifest-store';\nconst store=new AlgorandManifestStore(':memory:');store.close(); const prepare:typeof prepareAlgorandManifest=prepareAlgorandManifest; void prepare;`,
  );
  run(
    process.execPath,
    [
      join(modules, "typescript/bin/tsc"),
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2023",
      "--strict",
      "--skipLibCheck",
      "--outDir",
      "build",
      "check.ts",
      "example.ts",
    ],
    consumer,
  );
  // Execute the actual packaged example with a Python-signed router observation,
  // actual SDK unsigned transaction preparation and synthetic wallet signatures.
  writeFileSync(
    join(consumer, "runtime.mjs"),
    `import assert from 'node:assert/strict';import fs from 'node:fs';import {generateKeyPairSync,sign} from 'node:crypto';import {Address} from '@algorandfoundation/algokit-utils';import {decodeTransaction,encodeSignedTransaction,bytesForSigning} from '@algorandfoundation/algokit-utils/transact';import {runObservedManifest} from './build/example.js';import {buildAlgorandManifestTransactions,prepareAlgorandManifest} from '@402signal/algorand-batch-buyer/manifest';import {AlgorandManifestStore} from '@402signal/algorand-batch-buyer/manifest-store';
const vectors=JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "tests/fixtures/algorand-manifest-v2.json"))},'utf8'));process.env.LIVE402_FIXTURE='1';let signatures=0,sends=0;
for(const v of [vectors[1],vectors.at(-1)]){const pair=generateKeyPairSync('ed25519'),buyer=new Address(pair.publicKey.export({format:'der',type:'spki'}).subarray(-32)).toString(),envelope=JSON.parse(Buffer.from(v.challenge.paymentRequired,'base64').toString()),profile=v.request.merchant_profile,limits=v.request.buyer_limits,plan=prepareAlgorandManifest({profile,envelope,limits,buyer,raw:buildAlgorandManifestTransactions(profile,envelope,limits,buyer)}),journal=new AlgorandManifestStore(':memory:');
const input={journal,operationId:'packed',plan,proof:{routeResponseJson:JSON.stringify(v.response),routeRequestJson:JSON.stringify(v.request),trustedLogVkey:v.trusted_vkey,challenge:v.challenge},now:()=>v.now,confirmRouterPayment:async()=>true,reserveBudget:async(id,p)=>{assert.equal(id,'packed');assert.equal(p.scope,plan.scope)},readParams:async()=>({'genesis-hash':envelope.extensions['402signal-atomic-batch'].feeQuote.genesisHash,'genesis-id':'mainnet-v1.0','last-round':1000,fee:0,'min-fee':1000}),sign:async(raw,idx)=>{signatures++;return raw.map((b,i)=>{if(!i)return undefined;const txn=decodeTransaction(b);return encodeSignedTransaction({txn,sig:sign(null,bytesForSigning.transaction(txn),pair.privateKey)})})},send:async(u,p)=>{sends++;return {status:200,body:{billing:{settlement_state:'provider_ack',amount_atomic:plan.group.totalAtomic,sponsor_fee_micro_algo:plan.manifest.feeQuote.sponsorFeeMicroAlgo},batch:{profile,groupId:plan.group.groupId,jobCount:plan.manifest.jobCount,paymentCount:plan.manifest.paymentCount,items:limits.job_hashes.map((jobHash,i)=>{const paymentIndex=profile==='algorand-atomic-multi-item-v1'?i+1:1;return{index:i+1,jobHash,paymentIndex,transaction:plan.group.transfers[paymentIndex-1].transaction}})}}}}};
try{assert.equal((await runObservedManifest(input)).status,200);assert.equal((await runObservedManifest(input)).status,200);const bad={...input,operationId:'wrong-price',proof:{...input.proof,routeRequestJson:JSON.stringify({...v.request,buyer_limits:{...limits,max_total_amount_atomic:'1'}})}};assert.equal((await runObservedManifest(bad)).status,503);assert.equal((await runObservedManifest({...input,operationId:'unconfirmed',confirmRouterPayment:async()=>false})).status,503);assert.equal((await runObservedManifest({...input,operationId:'expired',now:()=>v.now+60})).status,503);}finally{journal.close();}}
assert.equal(signatures,2);assert.equal(sends,2);console.log(JSON.stringify({result:'PASS',packedProfiles:2,strictNodeNext:true,signatures,sends,unconfirmedOrChangedOrExpiredSigns:0}));`,
  );
  console.log(run(process.execPath, ["runtime.mjs"], consumer).trim());
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
