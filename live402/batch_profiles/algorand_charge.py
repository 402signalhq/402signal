"""Native Algorand MPP charge quote; not sessions or settlement authority."""
import base64, hashlib
from live402 import route_binding as rb
from . import algorand_generic as algo
from .algorand import _address
PROFILE = "algorand-mpp-charge-v1"
NETWORK, ASSET = algo.NETWORK, algo.ASSET
KEYS = {"network","asset","recipient","realm","max_amount_atomic","max_network_fee_micro_algo","fee_payer"}
def check(ok):
    if not ok: raise rb.BindingError("unsupported_algorand_charge")
def keys(value, required, optional=()):
    check(type(value) is dict and set(required)<=set(value)<=set(required)|set(optional))
def uint(value):
    from .base import uint as parse
    return parse(value)
def text(value, maximum):
    check(type(value) is str and 0<len(value.encode())<=maximum)
def address(value):
    _address(value)
    check(value!="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ")
def validate_limits(limits):
    keys(limits,KEYS);check(limits["network"]==NETWORK and limits["asset"]==ASSET)
    address(limits["recipient"]);text(limits["realm"],256)
    check(limits["realm"].strip() and all(32<=ord(c)<127 for c in limits["realm"]))
    uint(limits["max_amount_atomic"]);uint(limits["max_network_fee_micro_algo"])
    if limits["fee_payer"] is not None:
        address(limits["fee_payer"]);check(limits["fee_payer"]!=limits["recipient"])

def fee_model(request):
    """Exact allowed SDK0.9.4 fields; Ed25519 wrapper adds75msgpack bytes.
    No zero-address/default fields or optional signing mechanisms are permitted.
    """
    md=request["methodDetails"];p=md["suggestedParams"];sponsored=md.get("feePayer") is True
    def integer(n): return 1 if n<=127 else 2 if n<=255 else 3 if n<=65535 else 5 if n<=2**32-1 else 9
    def string(s):
        n=len(s.encode());return n+(1 if n<32 else 2 if n<=255 else 3)
    def binary(n): return n+(2 if n<=255 else 3)
    note="mppx:"+md["challengeReference"]+(":"+request["externalId"] if request.get("externalId") else "")
    def size(kind,fee):
        fields={"fv":integer(p["firstValid"]),"lv":integer(p["lastValid"]),"gen":string("mainnet-v1.0"),"gh":binary(32),"grp":binary(32),"snd":binary(32),"type":string(kind)}
        if fee: fields["fee"]=integer(fee)
        if kind=="pay": fields["rcv"]=binary(32)
        else: fields.update({"arcv":binary(32),"xaid":integer(int(md["asaId"])),"aamt":integer(int(request["amount"])),"lx":binary(32),"note":binary(len(note.encode()))})
        return (1 if len(fields)<16 else 3)+sum(string(k)+v for k,v in fields.items())
    kinds=["pay","axfer"] if sponsored else ["axfer"]
    required=lambda n:max(p["minFee"],p["fee"]*n)
    quoted=sum(required(size(k,0)) for k in kinds)
    sizes=[size(k,quoted if i==0 else 0) for i,k in enumerate(kinds)]
    check(quoted>=sum(required(n+75) for n in sizes))
    return quoted,sizes

def validate(request, context, limits):
    validate_limits(limits)
    check(context == rb.request_context(context["url"], "GET"))
    keys(request,{"amount","currency","recipient","methodDetails"},{"description","externalId"})
    text(request["currency"],64);check(request["recipient"]==limits["recipient"] and uint(request["amount"])<=uint(limits["max_amount_atomic"]))
    for key,maximum in [("description",4096),("externalId",256)]:
        if key in request: text(request[key],maximum)
    md=request["methodDetails"]
    keys(md,{"network","asaId","challengeReference","lease","suggestedParams"},{"feePayer","feePayerKey"})
    check(md["network"]==NETWORK and md["asaId"]==ASSET)
    text(md["challengeReference"],256)
    lease=base64.b64encode(hashlib.sha256(md["challengeReference"].encode()).digest()).decode()
    check(md["lease"]==lease)
    sponsored=limits["fee_payer"] is not None
    if sponsored: check(md.get("feePayer") is True and md.get("feePayerKey")==limits["fee_payer"])
    else: check(("feePayer" not in md or md["feePayer"] is False) and "feePayerKey" not in md)
    p=md["suggestedParams"]
    keys(p,{"fee","firstValid","lastValid","genesisHash","genesisId","minFee"})
    check(p["genesisHash"]==NETWORK.split(":",1)[1] and p["genesisId"]=="mainnet-v1.0")
    for key in ["fee","firstValid","lastValid","minFee"]: check(type(p[key]) is int and 0<=p[key]<=2**53-1)
    check(p["minFee"]>=1000 and 0<p["firstValid"]<=p["lastValid"]<=p["firstValid"]+1000)
    count=2 if sponsored else 1
    check(p["minFee"]*count<=uint(limits["max_network_fee_micro_algo"]))
    fee,_=fee_model(request);check(fee<=uint(limits["max_network_fee_micro_algo"]))
    return {"protocol":"mpp","method":"algorand","intent":"charge","network":NETWORK,"asset":ASSET,"recipient":request["recipient"],"amount_atomic":request["amount"],"currency_label":request["currency"],"fee_payer":limits["fee_payer"],"transaction_count":count,"minimum_group_fee_micro_algo":str(p["minFee"]*count),"network_fee_micro_algo":str(fee),"fee_quote_requires_buyer_validation":True,"challenge_reference":md["challengeReference"],"lease":lease,"suggested_params":p}
