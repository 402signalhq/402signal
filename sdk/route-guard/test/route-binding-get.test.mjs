import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {verifyRoute,withVerifiedRoute,RouteGuardError} from "../index.mjs";
const f=JSON.parse(readFileSync(new URL("../../../tests/fixtures/route-binding-get.json",import.meta.url)));
function options(){return {routeResponseJson:JSON.stringify(f.response),routeRequestJson:JSON.stringify(f.request),trustedLogVkey:f.trusted_vkey,request:{url:f.response.url,method:"GET",body:new Uint8Array()},challenge:{status:402,bodyText:JSON.stringify(f.challenge)},now:f.now};}
function reject(o,code){let calls=0;assert.throws(()=>withVerifiedRoute(o,()=>{calls++;}),e=>e instanceof RouteGuardError && (!code || e.code===code));assert.equal(calls,0);}
test("Python signed full-query GET with ten observational tags verifies",()=>{const result=verifyRoute(options());assert.equal(result.request.url,f.response.url);assert.deepEqual(result.accepted,f.challenge.accepts[0]);});
test("request query order, encoding, value, method, body, origin and path bind before callback",()=>{
 const url=f.response.url;
 for(const change of [{url:url.replace("query=x402%20protocol&max_results=5","max_results=5&query=x402%20protocol")},{url:url.replace("%20","+")},{url:url.replace("max_results=5","max_results=6")},{url:url.replace("search.example","other.example")},{url:url.replace("/search?","/other?")},{method:"POST"},{body:Buffer.from("{}")}]){const o=options();Object.assign(o.request,change);reject(o);}
});
test("metadata and declared resource mutations remain bound before callback",()=>{
 for(const change of [{serviceName:"other"},{tags:[...f.challenge.resource.tags].reverse()},{tags:["other"]},{url:f.response.url},{url:f.response.url.split("?")[0]+"?query=other"},{url:"https://other.example/search"}]){const o=options(),env=structuredClone(f.challenge);Object.assign(env.resource,change);o.challenge.bodyText=JSON.stringify(env);reject(o);}
});
test("typed bounded metadata rejects before quote comparison",()=>{
 for(const change of [{serviceName:null},{serviceName:{}},{serviceName:""},{serviceName:"x".repeat(33)},{serviceName:"x\n"},{serviceName:"café"},{tags:"x"},{tags:[null]},{tags:Array(17).fill("x")},{tags:["x".repeat(33)]},{tags:[""]},{tags:["x\n"]},{tags:[{}]},{iconUrl:"https://example.com/icon"}]){const o=options(),env=structuredClone(f.challenge);Object.assign(env.resource,change);o.challenge.bodyText=JSON.stringify(env);reject(o,"unsupported_resource");}
});
test("complete metadata comparison includes header/body channels",()=>{const o=options();o.challenge.paymentRequired=Buffer.from(o.challenge.bodyText).toString("base64");verifyRoute(o);const env=structuredClone(f.challenge);env.resource.tags.reverse();o.challenge.bodyText=JSON.stringify(env);reject(o,"ambiguous_challenge");});
