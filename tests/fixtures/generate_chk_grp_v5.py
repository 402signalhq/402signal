"""Signed chk_grp observations without buyer merchant_profile.

Run from the repository root:
  PYTHONPATH=.:tests python tests/fixtures/generate_chk_grp_v5.py
"""
import json, os, re, tempfile
from pathlib import Path
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from live402.pq import receipt, store, events
from live402 import batch_binding as bb, batch_codec, route_binding as rb

ROOT = Path(__file__).parent
NOW = 1800000000


def buyer(req):
    return {key: req[key] for key in req if key != "merchant_profile"}


def wire_sources():
    items = json.loads((ROOT / "batch-observation-wire.json").read_text())
    generic = json.loads((ROOT / "algorand-generic-v5.json").read_text())
    items.append({"request": generic["request"], "challenge": generic["challenge"]})
    native = json.loads((ROOT / "base-native-mpp-v5.json").read_text())
    items.append(
        {
            "request": native["request"],
            "challenge": native["challenge"],
            "now": native["now"],
        }
    )
    invoice = next(
        v
        for v in json.loads((ROOT / "algorand-manifest-v2.json").read_text())
        if v["request"].get("merchant_profile") == "algorand-aggregate-invoice-v1"
    )
    items.append({"request": invoice["request"], "challenge": invoice["challenge"]})
    return items


def observation(source, now):
    challenge = json.loads(json.dumps(source["challenge"]))
    if challenge.get("wwwAuthenticate"):
        expiry = events.jcs.utc_seconds_z(now + 40)
        challenge["wwwAuthenticate"] = re.sub(
            r'expires="[^"]+"', 'expires="' + expiry + '"', challenge["wwwAuthenticate"]
        )
    return {
        "request": rb.request_context(source["request"]["url"], "GET"),
        "observed_at": now,
        "challenge": challenge,
    }


def issue(req, obs):
    binding = bb.build(req, obs)
    codec, _inferred = batch_codec.limits_match(req["buyer_limits"])
    result = {
        "url": req["url"],
        **batch_codec.identity(codec),
        "live": True,
        "payable": True,
        "invocable": False,
        "status": 402,
        "selected_payment": None,
        "batch_terms": binding["terms"],
        "batch_binding": binding,
    }
    return receipt.attach_to_route(result, req)


out = []
with tempfile.TemporaryDirectory() as tmp, patch.dict(
    os.environ,
    {
        "LIVE402_FIXTURE": "1",
        "LIVE402_PQ_LOG": "1",
        "LIVE402_PQ_LOG_DB": tmp + "/pq.sqlite",
    },
), patch("time.time", return_value=NOW):
    store.reset()
    vkey = receipt.configure_signer(Ed25519PrivateKey.generate())
    for source in wire_sources():
        now = int(source.get("now", NOW))
        req = buyer(source["request"])
        obs = observation(source, now)
        if "now" in source:
            obs["challenge"] = json.loads(json.dumps(source["challenge"]))
        result = issue(req, obs)
        assert "pq_trust" in result, result
        assert "merchant_profile" not in req
        assert result["job"] == "chk_grp"
        out.append(
            {
                "request": req,
                "challenge": obs["challenge"],
                "response": result,
                "trusted_vkey": vkey,
                "now": now,
                "codec": result["codec"],
                "profile": result["batch_binding"]["profile"],
            }
        )
    receipt.configure_signer(None)
    store.reset()

(ROOT / "batch-chk-grp-v5.json").write_text(json.dumps(out, indent=2) + "\n")
print([(item["codec"], item["profile"], item["request"]["url"]) for item in out])
