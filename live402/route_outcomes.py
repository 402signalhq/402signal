"""Public miss classification; this never grants settlement authority."""

NORMAL_MISS_REASONS = frozenset({
    "no_candidates", "no_402_envelope", "no_payto", "reachable_200",
    "quote_expired", "no_input_schema", "constraints_unmet", "unsafe_to_probe",
})


def is_normal_miss(body: object) -> bool:
    """A completed, non-executable answer, without an operational failure.

    Missing completion flags are supported for legacy probe producers; explicit
    incomplete/budget-limited evaluations must retain their error status.
    Callers independently verify the billing state and absence of a receipt.
    """
    return (
        isinstance(body, dict)
        and body.get("live") is False
        and body.get("payable") is False
        and "selected_payment" in body and body["selected_payment"] is None
        and isinstance(body.get("miss_reason"), str)
        and body["miss_reason"] in NORMAL_MISS_REASONS
        and all(body.get(key) is None for key in ("error", "binding_error", "binding_error_reason"))
        and body.get("evaluation_complete", True) is True
        and body.get("candidate_evaluation_complete", True) is True
        and body.get("probe_budget_exhausted", False) is False
    )
