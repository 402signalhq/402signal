import { encodeFunctionData, parseAbi } from 'viem';
import { address, getAddressEncoder } from '@solana/kit';
import type { BuyerConfig } from './buyer.js';
import { RAILS, railInfo } from './config.js';
import { assert } from './json.js';
import { checkNetwork, rpc } from './confirmation.js';
import { tokenAccount, TOKEN, validateMainnetPolicy } from './mainnet-policy.js';
import { http, type Transport } from './transport.js';

export async function preflight(c: BuyerConfig, send: Transport = http) {
  assert(c.mode === 'mainnet','mainnet_config_required'); const p = validateMainnetPolicy(c.mainnet);
  const results = [];
  for (const rail of RAILS) {
    try {
      await checkNetwork(rail,p,send);
      const info = railInfo(rail,'mainnet'), buyer = p.buyerAddresses[rail], seller = c.sellerPayTo[rail];
      let balance = 0n;
      if (rail === 'base') {
        const data = encodeFunctionData({abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[buyer as `0x${string}`]});
        const value = await rpc(p.rpcUrls.base,'eth_call',[{to:info.asset,data},'latest'],send);
        assert(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value),'balance_unavailable'); balance = BigInt(value);
      } else if (rail === 'solana') {
        for (const owner of [buyer,seller]) {
          const ata = await tokenAccount(owner,info.asset);
          const result = await rpc(p.rpcUrls.solana,'getAccountInfo',[ata,{encoding:'base64',commitment:'finalized'}],send);
          assert(result?.value?.owner === TOKEN && result.value.data?.[1] === 'base64','solana_token_account_required');
          const data = Buffer.from(result.value.data[0],'base64');
          assert(data.length === 165 && data[108] === 1 && data.readUInt32LE(72) === 0 && data.readUInt32LE(129) === 0,
            'solana_token_account_policy_refused');
          assert(data.subarray(0,32).equals(Buffer.from(getAddressEncoder().encode(address(info.asset)))) &&
            data.subarray(32,64).equals(Buffer.from(getAddressEncoder().encode(address(owner)))), 'solana_token_account_identity_refused');
          if (owner === buyer) balance = data.readBigUInt64LE(64);
        }
      } else {
        for (const owner of [buyer,seller]) {
          const r = await send(p.rpcUrls.algorand.replace(/\/$/,'')+'/v2/accounts/'+encodeURIComponent(owner),'GET');
          assert(r.status === 200 && r.body?.address === owner && (!r.body['auth-addr'] || r.body['auth-addr'] === owner),'algorand_account_unavailable_or_rekeyed');
          const holding = r.body.assets?.find((a:any)=>String(a['asset-id']) === info.asset);
          assert(holding && holding['is-frozen'] === false && Number.isSafeInteger(holding.amount), 'algorand_usdc_optin_required');
          if (owner === buyer) balance = BigInt(holding.amount);
        }
      }
      results.push({rail,network:info.network,buyer_usdc_atomic:balance.toString(), accounts_ready:balance >= BigInt(c.sellerMaxAtomic),
        campaign_cap_atomic:c.capAtomicPerRail[rail]});
    } catch { results.push({rail,accounts_ready:false,error:'network_or_account_preflight_failed'}); }
  }
  return {mode:'mainnet',reads_only:true,signs_or_sends_payments:false,results,
    note:'Checks network and token accounts only. Seller availability, facilitator behavior and wallet key matching are checked during a run.'};
}
