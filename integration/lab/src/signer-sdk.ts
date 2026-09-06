import type { PaymentRequired } from '@x402/core/types';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { privateKeyToAccount } from 'viem/accounts';
import { validateBuyer, type BuyerConfig, type Signer } from './buyer.js';
import { assert, decode64 } from './json.js';
import { type Rail, railInfo, safeUrl } from './config.js';
import { validateMainnetPolicy, mainnetTerms, checkBaseTypedData, checkSolanaMessage, checkAlgorandGroup } from './mainnet-policy.js';
import { checkNetwork } from './confirmation.js';

// Separate buyer process only. Imported lazily after CLI run gates. No wallet
// generation, funding, bridging, approvals, refunds or transfers outside x402.
export function sdkSigner(config: BuyerConfig, env: NodeJS.ProcessEnv = process.env, purpose: 'router' | 'seller' = 'seller'): Signer {
  if (config.mode === 'mainnet') return mainnetSigner(config,env,purpose);
  assert(config.mode === 'testnet', 'live_buyer_mainnet_review_required');
  assert(env.LAB_ALLOW_NETWORK === '1' && env.LAB_BUYER_ACK === 'testnet-spend-with-caps', 'buyer_not_authorized');
  return async (rail: Rail, challenge: PaymentRequired) => {
    const req = challenge.accepts[0]!;
    const client = new x402Client();
    if (rail === 'base') {
      const key = env.LAB_BUYER_BASE_PRIVATE_KEY;
      assert(key && /^0x[0-9a-fA-F]{64}$/.test(key), 'buyer_key_required');
      client.register(railInfo(rail, config.mode).network, new ExactEvmScheme(privateKeyToAccount(key as `0x${string}`)));
    } else if (rail === 'solana') {
      const key = decode64(env.LAB_BUYER_SOLANA_KEY_B64, 64); assert(key.length === 64, 'invalid_buyer_key');
      const signer = await createKeyPairSignerFromBytes(key);
      assert(req.extra?.feePayer !== signer.address, 'buyer_must_not_be_fee_payer');
      const rpcUrl = env.LAB_SOLANA_RPC_URL; assert(rpcUrl, 'rpc_url_required'); safeUrl(rpcUrl);
      client.register(railInfo(rail, config.mode).network, new ExactSvmScheme(signer, { rpcUrl }));
    } else {
      const key = decode64(env.LAB_BUYER_ALGORAND_KEY_B64, 64); assert(key.length === 64, 'invalid_buyer_key');
      const signer = toClientAvmSigner(key.toString('base64'));
      assert(req.extra?.feePayer !== signer.address, 'buyer_must_not_be_fee_payer');
      const algodUrl = env.LAB_ALGOD_URL; assert(algodUrl, 'rpc_url_required'); safeUrl(algodUrl);
      client.register(railInfo(rail, config.mode).network, new ExactAvmScheme(signer, { algodUrl, algodToken: env.LAB_ALGOD_TOKEN }));
    }
    // Only a fixed, validated option reaches SDK selection. Ignore untrusted
    // optional extensions that could introduce approvals or alternate flows.
    return client.createPaymentPayload({ x402Version: 2, resource: challenge.resource, accepts: [req] });
  };
}

function mainnetSigner(config: BuyerConfig, env: NodeJS.ProcessEnv, purpose: 'router' | 'seller'): Signer {
  assert(env.LAB_ALLOW_NETWORK === '1' && env.LAB_BUYER_ACK === (purpose === 'router' || config.routePilot ? 'mainnet-sponsored-route-pilot' : 'mainnet-sponsored-seller-pilot') &&
    env.LAB_MAINNET_ACK === 'reviewed-separate-self-test-lab', 'live_buyer_mainnet_review_required');
  const policy = validateMainnetPolicy(config.mainnet);
  if (purpose === 'router') {validateBuyer(config); assert(config.routePilot, 'router_policy_required');}
  return async (rail, challenge) => {
    assert(challenge.accepts.length === 1, 'one_payment_option_required');
    const req = challenge.accepts[0]!;
    mainnetTerms(req,rail);
    const destination = purpose === 'router' ? config.routerPayTo[rail] : config.sellerPayTo[rail];
    assert(req.payTo === destination && (purpose === 'router' ? req.amount === '3000' :
      BigInt(req.amount) > 0n && BigInt(req.amount) <= BigInt(config.sellerMaxAtomic)), 'mainnet_recipient_or_price_refused');
    if (purpose === 'router') assert(challenge.resource?.url === config.routerUrl, 'router_resource_mismatch');
    assert(req.maxTimeoutSeconds > 0 && req.maxTimeoutSeconds <= 60 && Number.isInteger(req.maxTimeoutSeconds), 'invalid_payment_lifetime');
    if (rail !== 'base') assert(typeof req.extra?.feePayer === 'string' && (purpose === 'router' ? config.routePilot!.routerFeePayers[rail] : config.feePayers[rail]).includes(req.extra.feePayer), 'fee_payer_not_allowlisted');
    await checkNetwork(rail,policy);
    const expected = policy.buyerAddresses[rail];
    assert((rail === 'base' ? expected.toLowerCase() !== req.payTo.toLowerCase() : expected !== req.payTo) &&
      expected !== req.extra?.feePayer, 'distinct_buyer_required');
    const client = new x402Client();
    if (rail === 'base') {
      const key = env.LAB_BUYER_BASE_PRIVATE_KEY;
      assert(key && /^0x[0-9a-fA-F]{64}$/.test(key), 'buyer_key_required');
      const local = privateKeyToAccount(key as `0x${string}`);
      assert(local.address.toLowerCase() === expected.toLowerCase(), 'buyer_address_mismatch');
      client.register(req.network,new ExactEvmScheme({address:local.address,
        signTypedData: async (data: any) => { checkBaseTypedData(data,req,expected); return local.signTypedData(data); }}));
    } else if (rail === 'solana') {
      const bytes = decode64(env.LAB_BUYER_SOLANA_KEY_B64,64); assert(bytes.length === 64,'buyer_key_required');
      const local = await createKeyPairSignerFromBytes(bytes); assert(local.address === expected,'buyer_address_mismatch');
      client.register(req.network,new ExactSvmScheme({address:local.address, signTransactions:async (txs,options) => {
        assert(txs.length === 1,'one_transaction_required');
        await checkSolanaMessage(new Uint8Array(txs[0]!.messageBytes),req,expected);
        return local.signTransactions(txs,options);
      }}, {rpcUrl:policy.rpcUrls.solana}));
    } else {
      const bytes = decode64(env.LAB_BUYER_ALGORAND_KEY_B64,64); assert(bytes.length === 64,'buyer_key_required');
      const local = toClientAvmSigner(bytes.toString('base64')); assert(local.address === expected,'buyer_address_mismatch');
      client.register(req.network,new ExactAvmScheme({address:local.address, signTransactions:async (txs,indexes) => {
        checkAlgorandGroup(txs,indexes ?? [],req,expected);
        return local.signTransactions(txs,indexes);
      }}, {algodUrl:policy.rpcUrls.algorand}));
    }
    // Economic fields and network are unchanged. Only explicitly used SDK
    // hints are supplied; unsigned extensions, memo and blockhash hints cannot
    // introduce another payment flow or alter transaction construction.
    const clean = {...req,extra:rail === 'base' ? {name:'USD Coin',version:'2'} : {feePayer:req.extra!.feePayer}};
    const payload = await client.createPaymentPayload({x402Version:2,resource:challenge.resource,accepts:[clean]});
    return {...payload,accepted:req};
  };
}
