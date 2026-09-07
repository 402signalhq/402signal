import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, getBase58Encoder} from '@solana/kit';
import {ActiveSession, voucherMessageBytes} from '@solana/mpp/client';
import {createMemorySessionStore, encodeVoucherMessageBytes} from '@solana/mpp/server';

// Public deterministic test seed. Never fund or reuse as a real wallet.
const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
const channelId = getBase58Decoder().decode(new Uint8Array(32).fill(11));
const otherChannel = getBase58Decoder().decode(new Uint8Array(32).fill(12));
const publicKey = await webcrypto.subtle.importKey('raw',getBase58Encoder().encode(signer.address),{name:'Ed25519'},false,['verify']);
const verify = (voucher, data= voucher.data) => webcrypto.subtle.verify('Ed25519',publicKey,getBase58Encoder().encode(voucher.signature),voucherMessageBytes(data));

test('published client/server agree on versioned 50-byte vouchers across repeated calls',async()=>{
  const session=new ActiveSession(channelId,signer,{expiresAt:2000000000});
  for(let i=1;i<=20;i++){
    const voucher=await session.prepareIncrement(7n);
    assert.equal(session.cumulative,BigInt(i-1)*7n,'preparing does not record server acceptance');
    const bytes=voucherMessageBytes(voucher.data);
    assert.equal(bytes.length,50);
    assert.deepEqual([...bytes.slice(0,2)],[0x56,0x01]);
    assert.deepEqual(bytes,encodeVoucherMessageBytes({channelId,cumulativeAmount:BigInt(voucher.data.cumulativeAmount),expiresAt:BigInt(voucher.data.expiresAt)}));
    assert.equal(await verify(voucher),true);
    session.recordVoucher(voucher);
    assert.equal(session.cumulative,BigInt(i)*7n);
  }
  assert.equal(session.channelId,channelId);
});

test('changing channel, authorized cumulative amount or expiry invalidates signature',async()=>{
  const session=new ActiveSession(channelId,signer,{expiresAt:2000000000});
  const v=await session.prepareIncrement(7n);
  assert.equal(await verify(v),true);
  for(const data of [
    {...v.data,channelId:otherChannel},
    {...v.data,cumulativeAmount:'8',cumulative:'8'},
    {...v.data,expiresAt:v.data.expiresAt+1},
  ]) assert.equal(await verify(v,data),false);
  assert.equal(await webcrypto.subtle.verify('Ed25519',publicKey,getBase58Encoder().encode(v.signature),voucherMessageBytes(v.data).slice(2)),false,'old 48-byte framing must not be substituted');
});

test('nonce is not an independent signed payment identity',async()=>{
  const session=new ActiveSession(channelId,signer,{expiresAt:2000000000});
  const v=await session.prepareIncrement(7n);
  assert.deepEqual(voucherMessageBytes(v.data),voucherMessageBytes({...v.data,nonce:999}));
  assert.equal(await verify(v,{...v.data,nonce:999}),true);
  // Adapters must use the signed channel/cumulative commitment, not nonce, for replay.
});

test('reference store serializes same-channel updates; local sealing is not settlement evidence',async()=>{
  const store=createMemorySessionStore();
  await store.updateChannel(channelId,()=>({channelId,authorizedSigner:signer.address,cumulative:0n,deposit:100n,
    committedDeliveries:[],pendingDeliveries:[],nextDeliverySequence:0n,sealed:false}));
  await Promise.all(Array.from({length:100},()=>store.updateChannel(channelId,async current=>{
    await Promise.resolve();
    return {...current,cumulative:current.cumulative+1n};
  })));
  const result=await store.getChannel(channelId);
  assert.equal(result.cumulative,100n);
  const sealed=await store.markSealed(channelId);
  assert.equal(sealed.sealed,true);
  assert.equal(sealed.settledSignature,undefined);
  assert.equal((await createMemorySessionStore().getChannel(channelId)),undefined,'reference store is not restart durable');
});
