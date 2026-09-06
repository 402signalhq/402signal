import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "scale_capacity.py"
SPEC = importlib.util.spec_from_file_location("scale_capacity", MODULE_PATH)
scale_capacity = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(scale_capacity)


def test_20m_default_capacity_math():
    result = scale_capacity.plan(
        logical_requests_per_day=20_000_000,
        probes_per_request=5,
        burst_multiplier=5,
        success_rate=1.0,
        route_price_usd=0.003,
        facilitator_fee_usd=0.001,
        replay_rows=100_000,
    )

    assert round(result["average_rps"], 6) == round(20_000_000 / 86_400, 6)
    assert round(result["burst_rps"], 6) == round((20_000_000 / 86_400) * 5, 6)
    assert round(result["average_probe_rps"], 6) == round((20_000_000 / 86_400) * 5, 6)
    assert result["gross_contribution_per_success_usd"] == 0.002
    assert round(result["replay_capacity_minutes_at_average_request_rate"], 2) == 7.2


def test_success_rate_drives_payment_economics_not_request_load():
    result = scale_capacity.plan(
        logical_requests_per_day=20_000_000,
        probes_per_request=3,
        burst_multiplier=5,
        success_rate=0.1,
        route_price_usd=0.003,
        facilitator_fee_usd=0.001,
        replay_rows=1_000_000,
    )

    assert result["logical_requests_per_day"] == 20_000_000
    assert result["successes_per_day"] == 2_000_000
    assert result["gross_route_revenue_month_usd"] == 180_000
    assert result["facilitator_cost_month_usd"] == 60_000
    assert result["gross_contribution_month_usd"] == 120_000


def test_invalid_success_rate_rejected():
    try:
        scale_capacity.plan(
            logical_requests_per_day=1,
            probes_per_request=1,
            burst_multiplier=1,
            success_rate=1.01,
            route_price_usd=0.003,
            facilitator_fee_usd=0.001,
            replay_rows=1,
        )
    except ValueError as exc:
        assert "success_rate" in str(exc)
    else:
        raise AssertionError("success rate > 1 must fail")
