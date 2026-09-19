import { check } from "./policy.mjs";
export function agentsToolsSearch(query) {
  check(
    typeof query === "string" && query.trim().length > 0 && query.length <= 300,
    "invalid_search_query",
  );
  return {
    sellerId: "agentstools",
    url:
      "https://api.agentstools.dev/search?query=" +
      encodeURIComponent(query) +
      "&max_results=5",
    method: "GET",
    bodyText: "",
  };
}
export function parallelSearch(query) {
  check(
    typeof query === "string" && query.trim().length > 0 && query.length <= 300,
    "invalid_search_query",
  );
  return {
    sellerId: "parallel",
    url: "https://parallelmpp.dev/api/search",
    method: "POST",
    bodyText: JSON.stringify({ query, mode: "one-shot" }),
  };
}
export function routeRequest(request) {
  return JSON.stringify({
    url: request.url,
    networks: ["base"],
    max_price_usd: request.sellerId === "parallel" ? 0.01 : 0.001,
    require_route_binding: true,
    ...(request.method === "POST"
      ? {
          require_invocable: true,
          probe_request: {
            profile: "parallel-search-json-v1",
            method: "POST",
            body: request.bodyText,
          },
        }
      : { need: "web search" }),
  });
}
/** Fresh run only. Recovery is client.recover(id), never rerunning with a new ID. */
export async function runSearch({
  id,
  query,
  sellerId = "agentstools",
  buyer,
  client,
  trustedLogVkey,
}) {
  check(
    ["agentstools", "parallel"].includes(sellerId),
    "unknown_search_seller",
  );
  const request =
    sellerId === "parallel" ? parallelSearch(query) : agentsToolsSearch(query);
  buyer.reserve(id, request);
  const routeRequestJson = routeRequest(request);
  await client.prepare(id, routeRequestJson);
  const challenge = await client.challenge(id);
  const value = await buyer.signRouting(id, challenge);
  await client.setPaymentHeader(id, { value });
  const outcome = await client.submit(id);
  if (
    outcome.response?.status !== 200 ||
    outcome.classification?.settlementReport !== "settled"
  )
    return {
      state: buyer.validatedFreeMiss(id, outcome)
        ? "routing_free_miss"
        : "routing_unresolved_or_unpaid",
      outcome,
    };
  if (!(await buyer.confirmRouting(id, outcome)))
    return { state: "routing_confirmation_unknown", outcome };
  const sellerChallenge = await buyer.sellerChallenge(id);
  return buyer.executeSellerOnce(id, {
    outcome,
    routeRequestJson,
    trustedLogVkey,
    challenge: sellerChallenge,
  });
}
