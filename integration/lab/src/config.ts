import { readFileSync } from 'node:fs';
import { isAddress } from 'viem';
import { isAddress as isSolanaAddress } from '@solana/kit';
import { getDefaultAsset as evmAsset } from '@x402/evm';
import { getDefaultAsset as svmAsset } from '@x402/svm';
import { getDefaultAsset as avmAsset, isValidAlgorandAddress } from '@x402/avm';
import type { Network } from '@x402/core/types';
import { assert, atomic, object, parseJson } from './json.js';

export const RAILS = ['base', 'solana', 'algorand'] as const;
export type Rail = typeof RAILS[number];
export type Mode = 'offline' | 'testnet' | 'mainnet';
export const NETWORKS = {
  testnet: { base: 'eip155:84532', solana: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', algorand: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe' },
  mainnet: { base: 'eip155:8453', solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', algorand: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' },
} as const;
export const OFFLINE_ADDRESSES = {
  base: '0x1111111111111111111111111111111111111111',
  solana: '11111111111111111111111111111111',
  algorand: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
};
export interface RailConfig { payTo: string; facilitatorUrl: string; }
export interface Config {
  mode: Mode; origin: string; host: string; port: number; ledgerPath: string;
  priceAtomic: string; rails: Record<Rail, RailConfig>;
}
export function railInfo(rail: Rail, mode: Mode) {
  const network: Network = NETWORKS[mode === 'mainnet' ? 'mainnet' : 'testnet'][rail];
  const item = ({ base: evmAsset, solana: svmAsset, algorand: avmAsset }[rail])(network, 'USDC');
  return { network, asset: item.asset, decimals: item.decimals };
}
export function safeUrl(value: unknown, offline = false): URL {
  assert(typeof value === 'string', 'invalid_url');
  let url: URL; try { url = new URL(value); } catch { throw new Error('invalid_url'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  assert(!url.username && !url.password && !url.search && !url.hash, 'invalid_url');
  assert(offline ? loopback && url.protocol === 'http:' : url.protocol === 'https:' && !loopback, 'unsafe_url');
  return url;
}
export function validateConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const c = object(raw) as unknown as Config;
  assert(['offline', 'testnet', 'mainnet'].includes(c.mode), 'invalid_mode');
  const offline = c.mode === 'offline';
  const u = safeUrl(c.origin, offline); assert(u.pathname === '/', 'origin_must_not_have_path');
  assert(!c.origin.endsWith('/'), 'origin_must_not_end_with_slash');
  assert(Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535, 'invalid_port');
  assert(typeof c.host === 'string' && (offline ? c.host === '127.0.0.1' : ['127.0.0.1', '0.0.0.0'].includes(c.host)), 'unsafe_bind');
  assert(typeof c.ledgerPath === 'string' && c.ledgerPath.length > 0 && !c.ledgerPath.startsWith('/data/live402'), 'separate_ledger_required');
  assert(atomic(c.priceAtomic) > 0n && atomic(c.priceAtomic) <= 10000n, 'seller_price_out_of_bounds');
  if (!offline) assert(env.LAB_ALLOW_NETWORK === '1', 'network_not_authorized');
  if (!offline) assert(!u.hostname.endsWith('.invalid') && !u.hostname.includes('replace'), 'replace_origin_placeholder');
  if (c.mode === 'mainnet') assert(env.LAB_MAINNET_ACK === 'reviewed-separate-self-test-lab', 'mainnet_not_authorized');
  object(c.rails);
  for (const rail of RAILS) {
    const r = object(c.rails[rail]) as unknown as RailConfig;
    if (!offline) {
      assert(r.payTo !== OFFLINE_ADDRESSES[rail] && !r.payTo.includes('REPLACE'), 'seller_address_required');
      assert(({ base: isAddress, solana: isSolanaAddress, algorand: isValidAlgorandAddress }[rail])(r.payTo), 'invalid_seller_address');
      safeUrl(r.facilitatorUrl);
    }
  }
  return c;
}
export function loadConfig(path = process.env.LAB_CONFIG ?? 'config/offline.json'): Config {
  return validateConfig(parseJson(readFileSync(path, 'utf8')));
}
