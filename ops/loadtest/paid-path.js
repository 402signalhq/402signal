// k6 load test: the paid path in fixture mode (LOCAL_FREE=1 on the staging app).
// Exercises admission, discovery, ranking and the probe pipeline against the
// synthetic catalog without a facilitator or the replay authority. The replay
// store has its own benchmark (docs/replay-throughput-benchmark.md); combine
// the two numbers to reason about end-to-end capacity.
//
//   k6 run -e TARGET=https://402signal-staging.fly.dev -e VUS=20 -e DURATION=60s ops/loadtest/paid-path.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const TARGET = __ENV.TARGET || "https://402signal-staging.fly.dev";
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || "60s";

export const options = {
  scenarios: {
    paid: { executor: "constant-vus", vus: VUS, duration: DURATION },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
  },
};

const route = new Trend("route_ms", true);
const wins = new Counter("route_live");
const misses = new Counter("route_miss");
const busy = new Counter("route_503_or_429");

// Bodies match the synthetic fixture catalog (live402/data/fixtures.json):
// two Base hits, a Solana hit, and a listed URL that no longer answers (a
// miss). The fixture harness has no log signer, so require_route_binding is
// left out here; receipt signing is a sub-millisecond Ed25519 operation that
// the Merkle benchmark covers separately.
const BODIES = [
  { need: "weather", max_price_usd: 0.05 },
  { need: "web search", networks: ["solana"], max_price_usd: 0.02 },
  { need: "erc20 token balance", networks: ["base"] },
  { url: "https://fixture.402signal.local/weather-stale" },
];

export default function () {
  const body = BODIES[__ITER % BODIES.length];
  const r = http.post(`${TARGET}/route`, JSON.stringify(body), {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    tags: { name: "route" },
    timeout: "70s",
  });
  route.add(r.timings.duration);
  if (r.status === 200) {
    let live = false;
    try {
      live = r.json("live") === true;
    } catch (e) {
      live = false;
    }
    if (live) wins.add(1);
    else misses.add(1);
  } else if (r.status === 503 || r.status === 429) {
    busy.add(1);
  }
  check(r, { "completed (200/503)": (res) => res.status === 200 || res.status === 503 });
  sleep(0.1);
}
