import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmForRoute } from '../src/confirmation.js';

test('Solana allows finalization after the old confirmation window', async () => {
  let reads=0; const waits:number[]=[];
  const r=await confirmForRoute('solana',async()=> ++reads===10
    ? {state:'confirmed',transaction:'same-transaction',level:'solana_finalized'} : {state:'unknown'},
    async ms=>{waits.push(ms);});
  assert.equal(r.state,'confirmed');assert.equal(reads,10);
  assert.deepEqual(waits,Array(9).fill(2000));
});
test('Unconfirmed Solana terminates without unbounded polling',async()=>{
  let reads=0;let waits=0;
  const r=await confirmForRoute('solana',async()=>{reads++;return {state:'unknown'};},async()=>{waits++;});
  assert.equal(r.state,'unknown');assert.equal(reads,30);assert.equal(waits,29);
});
test('Already confirmed transactions require no wait on any rail',async()=>{
  for(const rail of ['base','solana','algorand'] as const){
    let reads=0;
    const r=await confirmForRoute(rail,async()=>{reads++;return {state:'confirmed'};},async()=>{assert.fail('unexpected wait');});
    assert.equal(r.state,'confirmed');assert.equal(reads,1);
  }
});
test('Other rails retain their bounded read window',async()=>{
  for(const rail of ['base','algorand'] as const){
    let reads=0;const waits:number[]=[];
    await confirmForRoute(rail,async()=>{reads++;return {state:'unknown'};},async ms=>{waits.push(ms);});
    assert.equal(reads,8);assert.deepEqual(waits,Array(7).fill(1000));
  }
});
