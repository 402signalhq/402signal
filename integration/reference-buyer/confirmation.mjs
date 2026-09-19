import { decodeEventLog, parseAbi } from "viem";
import { BASE, USDC, address, check, strictJson } from "./policy.mjs";
const abi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
const READ = new Set([
  "eth_chainId",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_blockNumber",
  "eth_call",
]);
export function readOnlyRpc(url, fetchImpl = globalThis.fetch) {
  return async (method, params, signal) => {
    check(READ.has(method), "rpc_write_refused");
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(15000), signal])
        : AbortSignal.timeout(15000),
    });
    check(res.status === 200 && !res.redirected, "rpc_unavailable");
    const b = await readResponse(res);
    const j = strictJson(b, 1048576);
    check(
      j.jsonrpc === "2.0" && j.id === 1 && !j.error && "result" in j,
      "rpc_unavailable",
    );
    return j.result;
  };
}
export async function readResponse(r, limit = 1048576) {
  const reader = r.body?.getReader();
  const chunks = [];
  let n = 0;
  if (reader)
    try {
      for (;;) {
        const x = await reader.read();
        if (x.done) break;
        n += x.value.byteLength;
        check(n <= limit, "response_too_large");
        chunks.push(x.value);
      }
    } catch (e) {
      await reader.cancel();
      throw e;
    }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}
/** One independent observation, never a transaction submission or retry. */
export async function confirmBase(intent, transaction, rpc) {
  try {
    check(
      intent.network === BASE &&
        address(intent.asset) === USDC.toLowerCase() &&
        /^0x[0-9a-fA-F]{64}$/.test(transaction),
      "invalid_receipt",
    );
    check((await rpc("eth_chainId", [])) === "0x2105", "wrong_rpc_chain");
    const r = await rpc("eth_getTransactionReceipt", [transaction]);
    check(
      r?.status === "0x1" &&
        r.transactionHash?.toLowerCase() === transaction.toLowerCase() &&
        Array.isArray(r.logs),
      "receipt_unconfirmed",
    );
    const b = await rpc("eth_getBlockByNumber", [r.blockNumber, false]);
    check(
      b?.hash === r.blockHash &&
        BigInt(await rpc("eth_blockNumber", [])) >= BigInt(r.blockNumber) + 1n,
      "insufficient_confirmations",
    );
    const tx = await rpc("eth_getTransactionByHash", [transaction]);
    check(
      tx?.hash?.toLowerCase() === transaction.toLowerCase() &&
        tx.blockHash === r.blockHash &&
        tx.blockNumber === r.blockNumber &&
        address(tx.from) === address(r.from) &&
        address(tx.from) !== address(intent.buyer),
      "buyer_native_fee_refused",
    );
    let transfer = false,
      authorization = false,
      debited = 0n;
    for (const l of r.logs) {
      if (l.address?.toLowerCase() !== USDC.toLowerCase() || l.removed === true)
        continue;
      try {
        const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
        if (
          ev.eventName === "Transfer" &&
          address(ev.args.from) === address(intent.buyer)
        ) {
          debited += ev.args.value;
          transfer ||=
            address(ev.args.to) === address(intent.payTo) &&
            ev.args.value === BigInt(intent.amount);
        }
        if (ev.eventName === "AuthorizationUsed")
          authorization ||=
            address(ev.args.authorizer) === address(intent.buyer) &&
            ev.args.nonce.toLowerCase() === intent.nonce.toLowerCase();
      } catch {}
    }
    check(
      transfer && authorization && debited === BigInt(intent.amount),
      "payment_effects_mismatch",
    );
    return {
      state: "confirmed",
      transaction,
      level: "base_two_blocks_not_finality",
      buyer_native_fee_atomic: "0",
    };
  } catch {
    return { state: "unknown", transaction };
  }
}
