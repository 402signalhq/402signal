/** One owner-reviewed native MPP charge. Durable state replaces stateless HMAC. */
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Address } from "@algorandfoundation/algokit-utils";
import { Challenge, Credential, Receipt } from "mppx";
import { prepareNativeAlgorandCharge, inspectNativeAlgorandChargeCredential } from "./index.mjs";

export const ALGORAND_NATIVE_CHARGE_OPT_IN = "reviewed-owner-native-charge-v1";
export const ALGORAND_NATIVE_CHARGE_PATH = "/algorand/mpp/sha256";
const NETWORK = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const canonical = (x) => Array.isArray(x) ? "["+x.map(canonical).join(",")+"]" :
  x && typeof x === "object" ? "{"+Object.keys(x).sort().map(k=>JSON.stringify(k)+":"+canonical(x[k])).join(",")+"}" : JSON.stringify(x);
const sha = (x) => createHash("sha256").update(x).digest("hex");
const copy = (x) => JSON.parse(canonical(x));
const same = (a,b) => canonical(a) === canonical(b);
const check = (v) => { if (!v) throw Error("native_charge_refused"); };
const unknown = () => ({status:409,body:{error:"payment_outcome_unknown",new_payment_allowed:false}});
const refused = () => ({status:400,body:{error:"native_charge_refused"}});
export function validateNativeAlgorandLabConfig(c, now = Date.now()) {
  check(c && Object.keys(c).sort().join(",") ===
    "amountAtomic,asset,buyer,campaignId,createdAt,expiresAt,maxNetworkFeeMicroAlgo,network,recipient,rpcUrl,url,version");
  const u = new URL(c.url), rpc = new URL(c.rpcUrl);
  check(c.version === 1 && typeof c.campaignId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(c.campaignId));
  check(u.protocol === "https:" && u.href === c.url && !u.username && !u.password &&
    !u.port && !u.search && !u.hash && u.pathname === ALGORAND_NATIVE_CHARGE_PATH);
  check(rpc.origin === c.rpcUrl && !rpc.username && !rpc.password &&
    (rpc.protocol === "https:" || (process.env.LIVE402_FIXTURE === "1" &&
      rpc.origin.startsWith("http://127.0.0.1:"))));
  check(c.network === NETWORK && c.asset === "31566704" && c.amountAtomic === "1000");
  for (const address of [c.buyer,c.recipient])
    check(typeof address === "string" && Address.fromString(address).publicKey.some(x=>x!==0));
  check(c.buyer !== c.recipient);
  check(typeof c.maxNetworkFeeMicroAlgo === "string" &&
    /^[1-9][0-9]{3,4}$/.test(c.maxNetworkFeeMicroAlgo) &&
    BigInt(c.maxNetworkFeeMicroAlgo) >= 1000n && BigInt(c.maxNetworkFeeMicroAlgo) <= 20000n);
  check(Number.isSafeInteger(c.createdAt) && c.createdAt > 0 && c.createdAt <= now &&
    Number.isSafeInteger(c.expiresAt) && c.expiresAt > c.createdAt &&
    c.expiresAt-c.createdAt <= 3600000);
  return copy(c);
}
function sdk(operation, config, extra = {}) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL("./lab-sdk-worker.mjs", import.meta.url), {
      workerData:{operation,config,...extra},
      // Do not inherit seller/provider credentials into this no-key SDK worker.
      env:process.env.LIVE402_FIXTURE === "1" ? {LIVE402_FIXTURE:"1"} : {},
    });
    let done = false;
    const finish = (error,value) => {
      if (done) return; done = true; clearTimeout(timer);
      void worker.terminate();
      error ? reject(Error("native_charge_unknown")) : resolve(value);
    };
    const timer = setTimeout(()=>finish(true), operation === "pay" ? 19000 : 10000);
    worker.once("error",()=>finish(true));
    worker.once("exit",()=>finish(true));
    worker.once("message",message=>finish(!message?.ok,message?.value));
  });
}
export function createNativeAlgorandLabMerchant({config,journal,now=Date.now}) {
  const c = validateNativeAlgorandLabConfig(config,now());
  const key = (stage) => sha(canonical(["lab-native-algorand-charge-v1",c.campaignId,stage]));
  const put = (stage,value) => {
    const inserted = journal.once(key(stage),value);
    check(same(journal.get(key(stage)),value)); return inserted;
  };
  put("scope",c);
  const get = (stage) => journal.get(key(stage));
  const fresh = () => check(now() >= c.createdAt && now() < c.expiresAt);
  const outcome = (record,confirmation) => {
    const receipt = Receipt.from(JSON.parse(Buffer.from(record.receipt,"base64url").toString("utf8")));
    check(receipt.method === "algorand" && receipt.status === "success" &&
      receipt.reference === confirmation.transactionId);
    return {status:200,headers:{"Payment-Receipt":record.receipt},body:{
      result:sha(c.url),algorithm:"sha256",input:c.url,
      payment:{transactionId:confirmation.transactionId,confirmedRound:confirmation.confirmedRound},
    }};
  };
  async function reconcile() {
    const saved = get("outcome");
    if (saved) return copy(saved);
    const sent = get("send");
    if (!sent) return unknown();
    try {
      const confirmation = await sdk("observe",c,{plan:sent.plan});
      put("confirmed",confirmation);
      const receipt = get("receipt");
      if (!receipt) return unknown();
      const out = outcome(receipt,confirmation);
      put("outcome",out); return out;
    } catch { return unknown(); }
  }
  return {
    path:ALGORAND_NATIVE_CHARGE_PATH,
    // Administrative read-only chain recovery never repeats SDK verification/broadcast.
    reconcile,
    async request(url,header,recoveryOnly=false) {
      if (url !== c.url) return refused();
      if (recoveryOnly) return header === undefined ? copy(get("outcome") ?? unknown()) : refused();
      const issued = get("offer");
      if (header === undefined) {
        if (get("send")) return unknown();
        if (issued) {
          if (now() >= issued.plan.inspection.expiresAt*1000) return unknown();
          return {status:402,bodyText:"",headers:{"WWW-Authenticate":issued.challenge.wwwAuthenticate}};
        }
        try {
          fresh();
          if (!put("issue",{campaignId:c.campaignId})) return unknown();
          const request = await sdk("issue",c);
          fresh();
          const expiresAt = Math.min(Math.floor(now()/1000)+60,Math.floor(c.expiresAt/1000));
          const challenge = {status:402,bodyText:"",paymentRequired:null,
            wwwAuthenticate:Challenge.serialize({
              id:randomUUID(),realm:new URL(c.url).host,method:"algorand",intent:"charge",
              expires:new Date(expiresAt*1000).toISOString(),request,
            })};
          const plan = prepareNativeAlgorandCharge({
            request:{url:c.url,method:"GET",body:new Uint8Array()},challenge,buyer:c.buyer,
            limits:{network:c.network,asset:c.asset,recipient:c.recipient,
              realm:new URL(c.url).host,max_amount_atomic:"1000",
              max_network_fee_micro_algo:c.maxNetworkFeeMicroAlgo,fee_payer:null},
            now:Math.floor(now()/1000),
          });
          check(plan.raw.length === 1 && plan.paymentIndex === 0);
          put("offer",{challenge,plan});
          return {status:402,bodyText:"",headers:{"WWW-Authenticate":challenge.wwwAuthenticate}};
        } catch { return unknown(); }
      }
      try {
        check(issued);
        const credential = await inspectNativeAlgorandChargeCredential(issued.plan,header);
        const send = {authorizationDigest:sha(header),plan:issued.plan,credential};
        const previous = get("send");
        if (previous) {
          check(same(previous,send));
          return copy(get("outcome") ?? unknown());
        }
        fresh(); check(now() < issued.plan.inspection.expiresAt*1000);
        // Synchronous durable claim is the final boundary before any broadcast.
        try {
          if (!put("send",send)) return unknown();
          const receipt = await sdk("pay",c,{credential,plan:issued.plan});
          put("receipt",{receipt});
          return await reconcile();
        } catch { return unknown(); }
      } catch { return refused(); }
    },
  };
}
