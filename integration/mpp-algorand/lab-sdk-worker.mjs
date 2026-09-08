/** Isolated SDK execution: no wallet, inherited provider auth, or redirect target. */
import { parentPort, workerData } from "node:worker_threads";
import { algorand } from "@goplausible/algorand-mpp-sdk/server";
import { Receipt } from "mppx";
import { encodeTransactionRaw, transactionCodec } from "@algorandfoundation/algokit-utils/transact";

const check = (v) => { if (!v) throw Error("native_charge_unknown"); };
const { operation, config, credential, plan } = workerData;
const endpoint = new URL(config.rpcUrl);
check(endpoint.origin === config.rpcUrl && !endpoint.username && !endpoint.password);
check(endpoint.protocol === "https:" ||
  (process.env.LIVE402_FIXTURE === "1" && endpoint.origin.startsWith("http://127.0.0.1:")));
const originalFetch = globalThis.fetch;
let posts = 0, reads = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = init.method ?? "GET";
  check(u.origin === endpoint.origin && !u.search && !u.hash);
  if (method === "POST") {
    check(operation === "pay" && ++posts === 1 && u.pathname === "/v2/transactions");
    check(Buffer.from(init.body).equals(Buffer.from(credential.payload.paymentGroup[0], "base64")));
  } else {
    check(method === "GET" && ++reads <= 20 &&
      (u.pathname === "/v2/transactions/params" ||
       (operation !== "issue" && u.pathname === "/v2/transactions/pending/" + plan.inspection.transactionIds[0])));
  }
  const result = await originalFetch(u, {
    method, body: init.body, headers: method === "POST" ? {"Content-Type":"application/x-binary"} : {},
    redirect: "error", signal: AbortSignal.timeout(4000),
  });
  const chunks = []; let length = 0;
  for await (const chunk of result.body ?? []) {
    length += chunk.length; check(length <= 32768); chunks.push(chunk);
  }
  return new Response(Buffer.concat(chunks), {status:result.status, headers:{"Content-Type":"application/json"}});
};
try {
  if (operation === "observe") {
    const params = await fetch(config.rpcUrl + "/v2/transactions/params");
    check(params.status === 200);
    const network = await params.json();
    check(network["genesis-hash"] === config.network.slice(9) && network["genesis-id"] === "mainnet-v1.0");
    const response = await fetch(config.rpcUrl + "/v2/transactions/pending/" + plan.inspection.transactionIds[0]);
    check(response.status === 200);
    const row = await response.json(), round = row["confirmed-round"];
    check(Number.isSafeInteger(round) && round > 0 && !row["pool-error"]);
    const transaction = transactionCodec.decode(row.txn?.txn, "json");
    check(Buffer.from(encodeTransactionRaw(transaction)).equals(Buffer.from(plan.raw[0], "base64")));
    check(transaction.txId() === plan.inspection.transactionIds[0]);
    check(round >= Number(transaction.firstValid) && round <= Number(transaction.lastValid));
    parentPort.postMessage({ok:true, value:{transactionId:transaction.txId(), confirmedRound:round}});
  } else {
    check(operation === "issue" || operation === "pay");
    const server = algorand.charge({
      recipient:config.recipient, asaId:31566704n, network:config.network, algodUrl:config.rpcUrl,
    });
    if (operation === "issue") {
      const request = await server.request({request:{
        amount:"1000", currency:"USDC", recipient:"",
        methodDetails:{challengeReference:"", lease:""}, externalId:config.campaignId,
      }});
      check(!request.methodDetails.feePayer && !request.methodDetails.feePayerKey);
      parentPort.postMessage({ok:true,value:request});
    } else {
      const receipt = await server.verify({credential});
      check(posts === 1 && receipt.method === "algorand" && receipt.status === "success" &&
        receipt.reference === plan.inspection.transactionIds[0]);
      parentPort.postMessage({ok:true,value:Receipt.serialize(receipt)});
    }
  }
} catch { parentPort.postMessage({ok:false}); }
