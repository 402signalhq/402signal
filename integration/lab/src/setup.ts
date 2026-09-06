import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RAILS, safeUrl, type Config } from './config.js';
import { validateBuyer, type BuyerConfig } from './buyer.js';
import { assert, parseJson } from './json.js';

export function configureMainnet(directory: string, publicWalletFile: string, origin?: string) {
  assert(directory === resolve(directory),'absolute_config_directory_required');
  const wallets = parseJson(readFileSync(publicWalletFile,'utf8'));
  for (const role of ['buyer','seller']) for(const rail of RAILS) assert(typeof wallets[role]?.[rail] === 'string','public_addresses_required');
  const buyer = parseJson(readFileSync('config/mainnet-buyer.example.json','utf8')) as BuyerConfig;
  const seller = parseJson(readFileSync('config/mainnet-seller.example.json','utf8')) as Config;
  buyer.mainnet!.buyerAddresses = wallets.buyer; buyer.sellerPayTo = wallets.seller;
  for(const rail of RAILS) seller.rails[rail].payTo = wallets.seller[rail];
  if(origin) {assert(safeUrl(origin).pathname === '/' && !origin.endsWith('/'),'seller_origin_required');seller.origin=origin;buyer.sellerOrigin=origin;}
  validateBuyer(buyer);
  mkdirSync(directory,{mode:0o700});
  for(const [name,c] of [['buyer-mainnet.json',buyer],['seller-mainnet.json',seller]] as const) {
    writeFileSync(join(directory,name),JSON.stringify(c,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
  }
  return {created:['buyer-mainnet.json','seller-mainnet.json'],cap_atomic_per_rail:buyer.capAtomicPerRail,
    seller_origin:buyer.sellerOrigin,remaining:'Set a dedicated HTTPS seller origin, review facilitator pins and choose explicit caps. No payments enabled.'};
}
