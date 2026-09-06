"""Bounded diagnostics and phase timings; never payment material or seller text."""
from __future__ import annotations

import contextvars
import math
import time
from contextlib import contextmanager

_current = contextvars.ContextVar('route_timings', default=None)
_started = contextvars.ContextVar('route_started', default=None)
_replayed = contextvars.ContextVar('route_replayed', default=False)
PHASES = frozenset({'verification', 'routing_probe', 'binding_validation', 'settlement', 'history', 'pq_receipt', 'replay_lookup', 'discovery', 'hydration', 'candidate_probing'})
BINDING_REASONS = frozenset({
    'unsupported_challenge', 'unsupported_json_value', 'invalid_json',
    'quote_expired', 'quote_changed', 'resource_changed', 'unresolved_policy',
    'unproven_observation', 'invalid_winner', 'invalid_evidence',
    'invalid_binding', 'invalid_binding_config', 'ambiguous_challenge', 'redirected_quote',
})


def binding_reason(exc):
    from live402.route_binding import BindingError
    reason = str(exc) if isinstance(exc, BindingError) else ''
    return reason if reason in BINDING_REASONS else 'invalid_evidence'


@contextmanager
def trace():
    values = {}
    token = _current.set(values)
    start_token = _started.set(time.monotonic())
    replay_token = _replayed.set(False)
    try:
        yield values
    finally:
        _current.reset(token)
        _started.reset(start_token)
        _replayed.reset(replay_token)


def milliseconds(start):
    elapsed = (time.monotonic() - start) * 1000
    return round(min(300000, max(0, elapsed)), 3) if math.isfinite(elapsed) else 0.0


@contextmanager
def phase(name):
    if name not in PHASES:
        raise ValueError('invalid_phase')
    start = time.monotonic()
    try:
        yield
    finally:
        values = _current.get()
        if values is not None:
            values[name] = min(300000, values.get(name, 0) + milliseconds(start))


def outcome(code, result):
    """Advisory server state, not independent confirmation or proof verification."""
    billing = result.get('billing')
    if not isinstance(billing, dict):
        return None
    state = billing.get('settlement_state')
    settled = billing.get('settled')
    attempted = billing.get('settlement_attempted')
    reason, action = 'settlement_unknown', 'reconcile_existing_payment'
    if state == 'settled' and settled is True and attempted is True:
        reason = 'route_settled' if code == 200 else 'route_settled_receipt_unavailable'
        action = 'verify_receipt' if code == 200 else 'reconcile_existing_payment'
    elif state == 'not_attempted' and settled is False and attempted is False:
        reason = 'binding_failed' if result.get('binding_error') else 'free_miss'
        action = 'fix_request_or_compatibility' if reason == 'binding_failed' else 'change_constraints'
    elif state == 'rejected' and settled is False:
        reason, action = 'payment_rejected', 'inspect_rejection'
    return {'version': 1, 'code': reason, 'next_action': action,
            'automatic_payment_retry': False, 'independent_confirmation': 'not_checked',
            'seller_execution': 'buyer_managed'}


def finish(out, values, start):
    code, original, headers = out
    # Replay returns the original outcome byte-for-byte, including its timing
    # snapshot. Never refresh expiry or mutate the cached response.
    if _replayed.get() or (isinstance(original, dict) and 'timings_ms' in original):
        return out
    result = dict(original) if isinstance(original, dict) else original
    timing = dict(values)
    timing['total'] = milliseconds(start)
    # Do not change x402 challenges or their matching payment-required header.
    if isinstance(result, dict) and 'x402Version' not in result:
        result['timings_ms'] = timing
        status = outcome(code, result)
        if status is not None:
            result['route_outcome'] = status
        binding = result.get('decision_binding')
        if isinstance(binding, dict) and type(binding.get('expires_at')) is int:
            result['binding_remaining_seconds_at_issue'] = max(0, min(120, binding['expires_at'] - int(time.time())))
    return code, result, headers


def finish_current(out):
    values, start = _current.get(), _started.get()
    return finish(out, values, start) if values is not None and start is not None else out


def mark_replayed():
    _replayed.set(True)
