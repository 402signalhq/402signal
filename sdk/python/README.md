# 402signal (Python)

Client helpers and an offline receipt verifier for buyers that use
[402Signal](https://402signal.com/), the pre-flight check for agent payments
over x402 and MPP. Python 3.10 or newer; the only dependency is `cryptography`
(Ed25519).

```sh
pip install 402signal
```

## What it does

- `signal402.challenge(request)` sends the unpaid request and returns the HTTP
  402 fee requirements, so your x402 client can authorize the $0.003 checking
  fee with your own wallet.
- `signal402.check(request, payment_signature)` resends the identical JSON with
  your `PAYMENT-SIGNATURE` header and classifies the answer (`live`, `miss`,
  `binding_unavailable`, `settled_evidence_failed`, `unknown_settlement`,
  `refused`). `recover(...)` re-reads a lost answer with the same
  authorization and your private `Replay-Key` instead of paying again.
- `signal402.verify_route_receipt(response, trusted_log_vkey)` verifies a
  retained paid answer offline: the reveal recomputes the public commitment,
  the public leaf hashes to the receipt's leaf, the RFC 6962 inclusion path
  reaches the checkpoint root, and the checkpoint carries an Ed25519 signature
  from the log key you pinned. It never trusts a key found in the response.

This package does not hold keys, sign, pay, or retry. Binding the receipt to
the seller's live challenge before you sign (the `quote_changed` and
`resource_changed` checks) is done by the Node guard
`@402signal/route-guard`; a Python port of that comparison is planned.

## Verify a retained answer

```python
import json
import os
import signal402

response = json.load(open("retained-route-response.json"))
verified = signal402.verify_route_receipt(response, trusted_log_vkey=os.environ["SIGNAL_LOG_VKEY"])
print(verified["origin"], verified["tree_size"], verified["index"])
```

`ReceiptError` is raised on any mismatch. Keep the complete paid response,
including `pq_trust.transparency.receipt` and `reveal`, together with the
original request; the reveal contains private request and decision evidence,
so do not put it in public logs.

## Run a check

```python
import signal402

request = {"url": "https://seller.example/x402", "require_route_binding": True}
fee = signal402.challenge(request)          # fee.outcome == "challenge"; fee.body["accepts"] lists the rails
signature = my_x402_client.authorize(fee.body)   # your wallet, your code
answer = signal402.check(request, signature, replay_key=my_private_replay_key)
if answer.outcome == "live":
    signal402.verify_route_receipt(answer.body, trusted_log_vkey=VKEY)
```

Read `live`, `payable`, `selected_payment` and `billing` together; the
outcome name is a summary. A settled fee is not reversed if the seller's offer
later changes, and a qualifying check is not a guarantee of delivery or output
quality.

The client refuses redirects (`signal402.RedirectRefused`) to keep payment
headers on the configured endpoint. The router URL must be https (plain http only to a loopback address,
for fixtures) with no credentials, query or fragment, and every answer is read
to at most 256 KiB (`signal402.MAX_RESPONSE_BYTES`).

## Development

```sh
PYTHONPATH=sdk/python/src python3 -m unittest discover -s sdk/python/tests
```

Publishing runs from `.github/workflows/publish-pypi.yml` on a `python-v*` tag
with PyPI Trusted Publishing; no API token is stored.
