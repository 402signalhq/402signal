// k6 load test: the free path (unpaid 402 challenge, preview, rails, pulse, health).
// These endpoints never touch the replay authority, so this measures the HTTP
// layer, admission engine and catalog reads on their own.
//
//   k6 run -e TARGET=https://402signal-staging.fly.dev -e VUS=50 -e DURATION=60s ops/loadtest/free-path.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const TARGET = __ENV.TARGET || "https://402signal-staging.fly.dev";
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || "60s";
// PREVIEW=0 skips /preview. Use it while a fresh staging catalog is still
// warming: until the shadow catalog is populated, /preview queries the public
// discovery feeds upstream, and a load test must never be pointed at those.
const PREVIEW = (__ENV.PREVIEW || "1") !== "0";

export const options = {
  scenarios: {
    free: { executor: "constant-vus", vus: VUS, duration: DURATION },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

// The unpaid challenge is an HTTP 402 by design; do not count it as a failure.
http.setResponseCallback(http.expectedStatuses(200, 402));

const challenge = new Trend("challenge_ms", true);
const preview = new Trend("preview_ms", true);
const cheap = new Trend("cheap_ms", true);

const NEEDS = ["weather", "web search", "token risk", "llm inference", "wallet balance"];

export default function () {
  const which = __ITER % 4;
  if (which === 0) {
    const r = http.post(`${TARGET}/route`, JSON.stringify({ need: "weather" }), {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      tags: { name: "challenge" },
    });
    challenge.add(r.timings.duration);
    check(r, { "402 challenge": (res) => res.status === 402 });
  } else if (which === 1 && PREVIEW) {
    const need = NEEDS[__VU % NEEDS.length];
    const r = http.get(`${TARGET}/preview?need=${encodeURIComponent(need)}`, { tags: { name: "preview" } });
    preview.add(r.timings.duration);
    check(r, { "preview 200": (res) => res.status === 200 });
  } else if (which === 2) {
    const r = http.get(`${TARGET}/rails`, { tags: { name: "rails" } });
    cheap.add(r.timings.duration);
    check(r, { "rails 200": (res) => res.status === 200 });
  } else {
    const r = http.get(`${TARGET}/health`, { tags: { name: "health" } });
    cheap.add(r.timings.duration);
    check(r, { "health 200": (res) => res.status === 200 });
  }
  sleep(0.05);
}
