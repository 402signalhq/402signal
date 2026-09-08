/** Default-off one-charge native MPP lab registration. No signing credentials. */
import { readFileSync, lstatSync, realpathSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type { Seller } from "./seller.js";
import type { BatchHttpMerchant } from "./http-server.js";
import { assert, parseJson } from "./json.js";
import { AlgorandManifestStore } from "./algorand-manifest-store.js";
export const ALGORAND_NATIVE_CHARGE_OPT_IN = "reviewed-owner-native-charge-v1";
export async function configuredNativeAlgorandCharge(
  seller: Seller, env: NodeJS.ProcessEnv = process.env,
) {
  const flag = env.LAB_ALGORAND_MPP_CHARGE ?? "";
  assert(!flag || flag === ALGORAND_NATIVE_CHARGE_OPT_IN, "native_algorand_opt_in_refused");
  if (!flag) return {merchants:[] as BatchHttpMerchant[], close:async()=>{}};
  assert(seller.ready && seller.config.mode === "mainnet", "native_algorand_mainnet_required");
  const file = env.LAB_ALGORAND_MPP_CHARGE_CONFIG;
  assert(file, "native_algorand_config_required");
  const st = lstatSync(file);
  assert(st.isFile() && !st.isSymbolicLink() && st.size <= 16384, "native_algorand_config_refused");
  const config = parseJson(readFileSync(file,"utf8"),16384);
  const origin = new URL(seller.config.origin);
  assert(origin.protocol === "https:" && origin.origin === seller.config.origin &&
    config.url === seller.config.origin + "/algorand/mpp/sha256" &&
    config.recipient === seller.config.rails.algorand.payTo, "native_algorand_scope_refused");
  // Production registration never permits the synthetic loopback transport.
  const rpc = new URL(config.rpcUrl);
  assert(rpc.protocol === "https:" && rpc.origin === config.rpcUrl, "native_algorand_rpc_refused");
  const modulePath = "../../../mpp-algorand/lab-merchant.mjs";
  const {validateNativeAlgorandLabConfig,createNativeAlgorandLabMerchant} = await import(modulePath);
  validateNativeAlgorandLabConfig(config);
  const parent = dirname(resolve(seller.config.ledgerPath));
  assert(realpathSync(parent) === parent, "native_algorand_journal_parent_refused");
  const dir = join(parent,"algorand-native-charge");
  if (existsSync(dir)) {
    const st = lstatSync(dir);
    assert(st.isDirectory() && !st.isSymbolicLink(), "native_algorand_journal_refused");
  } else mkdirSync(dir,{mode:0o700});
  const store = new AlgorandManifestStore(join(dir,config.campaignId+".sqlite"));
  try {
    const merchant = createNativeAlgorandLabMerchant({config,journal:store});
    return {
      merchants:[{path:merchant.path,authorizationHeader:"authorization",
        request:merchant.request.bind(merchant)}] as BatchHttpMerchant[],
      close:async()=>store.close(),
    };
  } catch (error) {store.close();throw error;}
}
