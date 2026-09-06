import test from 'node:test';
import assert from 'node:assert/strict';
import {checkNetwork} from '../src/confirmation.js';
import type {MainnetPolicy} from '../src/mainnet-policy.js';
import type {Transport} from '../src/transport.js';
test('Solana RPC identity requires full mainnet genesis, not truncated CAIP-2',async()=>{
 const policy={rpcUrls:{solana:'https://api.mainnet-beta.solana.com'}} as MainnetPolicy;
 const send=(result:string):Transport=>async()=>({status:200,headers:new Headers(),body:{jsonrpc:'2.0',id:1,result}});
 await checkNetwork('solana',policy,send('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'));
 for(const wrong of ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp','EtWTRABZaYq6iMfeYKouRu166VU2xqa1'])
  await assert.rejects(checkNetwork('solana',policy,send(wrong)),/solana_mainnet_required/);
});
