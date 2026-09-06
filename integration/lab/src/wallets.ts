import { mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { ed25519Generator } from '@algorandfoundation/algokit-utils/crypto';
import { mnemonicFromSeed } from '@algorandfoundation/algokit-utils/algo25';
import { toClientAvmSigner } from '@x402/avm';
import { assert } from './json.js';
import type { Rail } from './config.js';

// Offline only. Exclusive directory creation is the overwrite/interruption
// boundary: a partial run is preserved for manual recovery, never regenerated.
export async function createWallets(directory: string) {
  assert(directory === resolve(directory), 'absolute_wallet_directory_required');
  mkdirSync(directory,{mode:0o700});
  assert(lstatSync(directory).isDirectory() && !(lstatSync(directory).mode & 0o077), 'private_wallet_directory_required');
  const publicAddresses: Record<string,Record<Rail,string>> = {};
  const recovery: string[] = ['PRIVATE: dedicated Algorand accounts. Never upload or paste this file.'];
  for (const role of ['buyer','seller'] as const) {
    const base = generatePrivateKey(), sol = ed25519Generator(), algo = ed25519Generator();
    const solKey = Buffer.concat([sol.ed25519SecretKey,sol.ed25519Pubkey]);
    const algoKey = Buffer.concat([algo.ed25519SecretKey,algo.ed25519Pubkey]);
    const addresses = {base:privateKeyToAccount(base).address, solana:(await createKeyPairSignerFromBytes(solKey)).address,
      algorand:toClientAvmSigner(algoKey.toString('base64')).address};
    publicAddresses[role] = addresses;
    const prefix = 'LAB_'+role.toUpperCase();
    const env = [`${prefix}_BASE_PRIVATE_KEY=${base}`,`${prefix}_SOLANA_KEY_B64=${solKey.toString('base64')}`,
      `${prefix}_ALGORAND_KEY_B64=${algoKey.toString('base64')}`].join('\n')+'\n';
    writeFileSync(join(directory,role+'-mainnet.env'),env,{flag:'wx',mode:0o600,flush:true});
    recovery.push(`${role}: ${addresses.algorand}\n${mnemonicFromSeed(algo.ed25519SecretKey)}\n`);
  }
  writeFileSync(join(directory,'algorand-recovery.txt'),recovery.join('\n'),{flag:'wx',mode:0o600,flush:true});
  writeFileSync(join(directory,'addresses.json'),JSON.stringify(publicAddresses,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
  return {purpose:'mainnet_pilot',public_addresses:publicAddresses, transactions_sent:0, secrets_printed:false};
}
