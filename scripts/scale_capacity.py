#!/usr/bin/env python3
"""Deterministic 402Signal capacity planning math.

This is intentionally stdlib-only and does not assert measured production
capacity. It converts workload assumptions into request/probe/ledger rates so
load tests and infrastructure proposals use the same arithmetic.
"""

from __future__ import annotations

import argparse
import json

SECONDS_PER_DAY = 86_400
DAYS_PER_MONTH = 30


def positive_float(value: str) -> float:
    number = float(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return number


def nonnegative_float(value: str) -> float:
    number = float(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return number


def plan(
    *,
    logical_requests_per_day: float,
    probes_per_request: float,
    burst_multiplier: float,
    success_rate: float,
    route_price_usd: float,
    facilitator_fee_usd: float,
    replay_rows: float,
) -> dict:
    if success_rate < 0 or success_rate > 1:
        raise ValueError("success_rate must be between 0 and 1")

    average_rps = logical_requests_per_day / SECONDS_PER_DAY
    burst_rps = average_rps * burst_multiplier
    average_probe_rps = average_rps * probes_per_request
    burst_probe_rps = burst_rps * probes_per_request
    successes_per_day = logical_requests_per_day * success_rate
    monthly_successes = successes_per_day * DAYS_PER_MONTH
    gross_revenue_month = monthly_successes * route_price_usd
    facilitator_cost_month = monthly_successes * facilitator_fee_usd
    contribution_month = gross_revenue_month - facilitator_cost_month
    ledger_seconds = replay_rows / average_rps if average_rps else None

    return {
        "logical_requests_per_day": logical_requests_per_day,
        "average_rps": average_rps,
        "burst_multiplier": burst_multiplier,
        "burst_rps": burst_rps,
        "probes_per_request": probes_per_request,
        "average_probe_rps": average_probe_rps,
        "burst_probe_rps": burst_probe_rps,
        "success_rate": success_rate,
        "successes_per_day": successes_per_day,
        "successes_per_month_30d": monthly_successes,
        "route_price_usd": route_price_usd,
        "facilitator_fee_usd": facilitator_fee_usd,
        "gross_contribution_per_success_usd": route_price_usd - facilitator_fee_usd,
        "gross_route_revenue_month_usd": gross_revenue_month,
        "facilitator_cost_month_usd": facilitator_cost_month,
        "gross_contribution_month_usd": contribution_month,
        "replay_rows": replay_rows,
        "replay_capacity_seconds_at_average_request_rate": ledger_seconds,
        "replay_capacity_minutes_at_average_request_rate": (
            ledger_seconds / 60 if ledger_seconds is not None else None
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests-per-day", type=positive_float, default=20_000_000)
    parser.add_argument("--probes-per-request", type=positive_float, default=5)
    parser.add_argument("--burst-multiplier", type=positive_float, default=5)
    parser.add_argument("--success-rate", type=nonnegative_float, default=1.0)
    parser.add_argument("--route-price-usd", type=nonnegative_float, default=0.003)
    parser.add_argument("--facilitator-fee-usd", type=nonnegative_float, default=0.001)
    parser.add_argument("--replay-rows", type=positive_float, default=100_000)
    args = parser.parse_args()

    if args.success_rate > 1:
        parser.error("--success-rate must be <= 1")

    result = plan(
        logical_requests_per_day=args.requests_per_day,
        probes_per_request=args.probes_per_request,
        burst_multiplier=args.burst_multiplier,
        success_rate=args.success_rate,
        route_price_usd=args.route_price_usd,
        facilitator_fee_usd=args.facilitator_fee_usd,
        replay_rows=args.replay_rows,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
