"""Native MPP Base USDC charge authorization offer, pinned EIP-3009."""
import re
from live402 import route_binding as rb
from live402.batch_profiles.base import uint
from live402.batch_profiles.native_charge import check
NETWORK="eip155:8453"
ASSET="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
KEYS={"network","asset","recipient","max_call_amount_atomic","realm"}
def address(value):
    check(type(value) is str and re.fullmatch(r"0x[0-9a-fA-F]{40}",value) and int(value[2:],16)>0)
    return value.lower()
def validate(e,ctx,limits):
    try:
        rb.canonical(e);rb.canonical(limits)
        check(type(limits) is dict and set(limits)==KEYS and ctx==rb.request_context(ctx["url"],"GET"))
        check(type(e) is dict and set(e)>={"amount","currency","recipient","methodDetails"} and set(e)<={"amount","currency","recipient","methodDetails","description","externalId"})
        check(type(limits["realm"]) is str and 0<len(limits["realm"])<=256 and limits["realm"].strip() and all(32<=ord(c)<127 for c in limits["realm"]))
        d=e["methodDetails"]
        check(type(d) is dict and set(d)>={"chainId","credentialTypes"} and set(d)<={"chainId","credentialTypes","decimals"})
        check(type(d["chainId"]) is int and d["chainId"]==8453 and d["credentialTypes"]==["authorization"] and ("decimals" not in d or type(d["decimals"]) is int and d["decimals"]==6))
        for key in ("description","externalId"):
            check(key not in e or type(e[key]) is str and len(e[key])<=2048)
        check(limits["network"]==NETWORK and limits["asset"]==ASSET and address(e["currency"])==ASSET.lower() and address(e["recipient"])==address(limits["recipient"]) and uint(e["amount"])<=uint(limits["max_call_amount_atomic"]))
        return {"network":NETWORK,"asset":ASSET,"recipient":address(e["recipient"]),"per_call_amount_atomic":e["amount"],"credential_type":"authorization","intent":"charge"}
    except (ValueError,KeyError,TypeError,OverflowError):
        raise rb.BindingError("unsupported_native_base_charge") from None
