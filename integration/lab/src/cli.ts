import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync, accessSync, constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig, RAILS, type Rail, type Config, railInfo } from './config.js';
import { assert, LabError, parseJson } from './json.js';
import { Ledger } from './ledger.js';
import { Seller } from './seller.js';
import { server } from './http-server.js';
import { Buyer, validateBuyer } from './buyer.js';
import { UTILITIES, type Utility } from './utilities.js';
import { fixtureBuyerConfig, fixtureRouter, fixtureSigner } from './fixtures.js';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { ExactAvmScheme } from '@x402/avm/exact/server';

const args = process.argv.slice(2), command = args.shift() ?? 'help';
function flag(name: string): string | undefined {
  const i = args.indexOf('--' + name); if (i < 0) return undefined;
  assert(args[i + 1] && !args[i + 1]!.startsWith('--'), 'flag_value_required'); return args[i + 1];
}
const print = (x: unknown) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
async function main() {
  if (command === 'help') {
    print({ project: '402Signal Lab', safety: 'Offline by default. No real payment or production connection in demo.', commands: {
      'configure-route': '--config EXISTING_BUYER --output NEW_CONFIG; discover advertised production processing and pin router terms; no keys or payments.',
      'inspect-route': '--config ROUTE_CONFIG --rail base; unpaid challenge contract check.',
      'run-route': 'Explicit mainnet router→seller purchase with separate durable phases, caps and chain checks.',
      'recheck-route': '--config ROUTE_CONFIG --id EXISTING_ID; chain reads only, no payment continuation.',
      demo: 'Nine synthetic buyer→router→seller runs, ephemeral ledgers, loopback HTTP only.',
      serve: '--config config/offline.json (default) or your separately reviewed seller config.',
      doctor: 'Local environment and safe placeholder checks; no network or key reads.',
      plan: '--config config/buyer.example.json; no network, signing, or writes.',
      run: 'Testnet staging router only. Mainnet pilot uses run-seller.',
      'run-seller': 'Same flags/gates, but one seller payment only. Does not contact or test the router.',
      wallets: '--directory ABSOLUTE_NEW_DIRECTORY; generate six dedicated keys offline, print only public addresses.',
      'configure-mainnet': '--directory NEW_DIRECTORY --wallets ADDRESSES_JSON [--origin HTTPS_ORIGIN]; zero caps, no network or private keys.',
      preflight: '--config MAINNET_BUYER_CONFIG; read network and token account state without keys or payments.',
      recheck: '--config MAINNET_BUYER_CONFIG --id EXISTING_ID; read chain evidence, never re-sign or resubmit.',
      'contract-export': 'Emit SDK-generated mainnet terms, without connecting or signing; feed tools/router-contract.py.',
      faults: 'Loopback-only wire-failure endpoints on port 4022; refuses all payment headers.',
      summarize: '--directory reports/runs; combine self-test reports without mixing offline/testnet/mainnet data.',
    } }); return;
  }
  if (['configure-route','inspect-route','run-route','recheck-route'].includes(command)) {
    const path=flag('config');assert(path,'config_required');
    const c=validateBuyer(parseJson(readFileSync(path,'utf8')));
    assert(c.mode==='mainnet' && process.env.LAB_ALLOW_NETWORK==='1','mainnet_reads_not_enabled');
    const {ROUTE_PROTOCOL,checkAdvertisement,inspectRoute,RoutePilot,recheckRoute,routeBody}=await import('./route-pilot.js');
    const {http}=await import('./transport.js');
    const {challenge,selectTerms}=await import('./buyer.js');
    if(command==='configure-route') {
      const output=flag('output');assert(output && !existsSync(output),'new_config_output_required');
      assert(!c.routePilot,'already_configured');
      c.routerUrl='https://402signal.com/route';
      const ch=challenge(await http(c.routerUrl,'POST',routeBody(c,'base','payload/sha256')),c.routerUrl);
      checkAdvertisement(c,ch);
      c.routePilot={protocol:ROUTE_PROTOCOL,routerFeePayers:{base:[],solana:[],algorand:[]}};
      for(const rail of RAILS) {
        const options=ch.accepts.filter(a=>a.network===railInfo(rail,'mainnet').network);
        assert(options.length===1,'router_options_required');const r=options[0]!;
        c.routerPayTo[rail]=r.payTo;
        if(rail!=='base') {assert(typeof r.extra?.feePayer==='string','fee_payer_required');c.routePilot.routerFeePayers[rail]=[r.extra.feePayer];}
        selectTerms(c,rail,ch,'router');
      }
      validateBuyer(c);writeFileSync(output,JSON.stringify(c,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
      print({created:output,router:c.routerUrl,router_pay_to:c.routerPayTo,router_fee_payers:c.routePilot.routerFeePayers,
        caps_unchanged:c.capAtomicPerRail,ledger_preserved:c.ledgerPath,signs_or_sends_payments:false});return;
    }
    const rail=flag('rail') as Rail,name=(flag('utility')??'payload/sha256') as Utility;
    if(command==='inspect-route') {print(await inspectRoute(c,rail,name));return;}
    const id=flag('id');assert(id && /^[a-zA-Z0-9_-]{1,64}$/.test(id),'run_id_required');
    const {confirmOnce}=await import('./confirmation.js');
    const recoveryModule='../../sdk/route-guard/recovery.mjs';
    const {reconcilePayment}=await import(recoveryModule);
    const confirm=async(intent:import('./mainnet-policy.js').PaymentIntent,transaction:string)=>{
      const result=await reconcilePayment({rail:intent.rail,transaction,
        observe:({signal}:{signal:AbortSignal})=>confirmOnce(c.mainnet!,intent,transaction,(url,method,body,headers)=>{
          assert(!signal.aborted,'confirmation_aborted');return http(url,method,body,headers);
        })});
      return result.confirmation??{state:'unknown' as const};
    };
    if(command==='recheck-route') {
      const ledger=new Ledger(c.ledgerPath);
      try {
        const report=await recheckRoute(c,ledger,id,confirm);
        const dir=flag('report-dir');
        if(dir){mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,id+'.recheck-'+Date.now()+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});}
        print(report);if(!report.resolved)process.exitCode=1;
      }
      finally {ledger.close();}return;
    }
    const directory=flag('report-dir')??'reports';mkdirSync(directory,{recursive:true,mode:0o700});accessSync(directory,constants.W_OK);
    const out=join(directory,id+'.json');assert(!existsSync(out),'report_already_exists');
    assert(readFileSync('/labdata/trusted-pq-vkey.txt','utf8').trim().startsWith('402signal.com/pq/log/mainnet-v1+'),'trusted_pq_key_required');
    const {sdkSigner}=await import('./signer-sdk.js');
    const routerSign=sdkSigner(c,process.env,'router'),sellerSign=sdkSigner(c,process.env,'seller');
    const ledger=new Ledger(c.ledgerPath);
    try {
      const report=await new RoutePilot(c,ledger,routerSign,sellerSign,confirm).run(id,rail,name,(flag('scenario')??'purchase') as 'purchase'|'price_miss');
      writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});print(report);
      if(report.stopped_because)process.exitCode=1;
    } finally {ledger.close();}return;
  }
  if (command === 'wallets') {
    const directory = flag('directory'); assert(directory,'wallet_directory_required');
    const {createWallets} = await import('./wallets.js'); print(await createWallets(directory)); return;
  }
  if (command === 'configure-mainnet') {
    const directory=flag('directory'),wallets=flag('wallets'); assert(directory && wallets,'config_directory_and_public_wallets_required');
    const {configureMainnet}=await import('./setup.js'); print(configureMainnet(directory,wallets,flag('origin')));return;
  }
  if (command === 'preflight' || command === 'recheck') {
    const path = flag('config'); assert(path,'config_required');
    const c = validateBuyer(parseJson(readFileSync(path,'utf8')));
    assert(c.mode === 'mainnet' && process.env.LAB_ALLOW_NETWORK === '1','mainnet_reads_not_enabled');
    if (command === 'preflight') {
      const {preflight} = await import('./preflight.js'); const result = await preflight(c); print(result);
      if (result.results.some(r=>!r.accounts_ready)) process.exitCode = 1; return;
    }
    const id = flag('id'); assert(id && /^[a-zA-Z0-9_-]{1,64}$/.test(id),'run_id_required');
    const ledger = new Ledger(c.ledgerPath);
    try {
      const {confirmOnce} = await import('./confirmation.js');
      const saved = ledger.getIntent(id), transaction = saved.transaction ?? saved.intent.transaction;
      assert(transaction,'no_observed_transaction_id_manual_reconciliation_required');
      assert(saved.intent.buyer === c.mainnet!.buyerAddresses[saved.intent.rail] && saved.intent.payTo === c.sellerPayTo[saved.intent.rail], 'recheck_scope_mismatch');
      const result = await confirmOnce(c.mainnet!,saved.intent,transaction);
      ledger.recordConfirmation(id,result);
      if (result.state === 'confirmed') ledger.spendState(id,'reconciled');
      print({run_id:id,chain_confirmation:result,budget_released:false,payment_resubmitted:false,delivery:'not_rechecked'});
      if (result.state !== 'confirmed') process.exitCode = 1;
    } finally {ledger.close();} return;
  }
  if (command === 'doctor') {
    const p = JSON.parse(readFileSync('package.json', 'utf8'));
    const c = loadConfig(flag('config'));
    print({ node: process.version, required: 'Node.js 24 LTS', config_mode: c.mode, bind: c.host,
      seller_price_atomic: c.priceAtomic, rails: RAILS, dependencies: p.dependencies,
      live_payments_tested: false, note: 'Does not inspect wallets, contact facilitators, or validate balances.' }); return;
  }
  if (command === 'summarize') {
    const dir = flag('directory'); assert(dir, 'report_directory_required');
    const { summarize } = await import('./summary.js');
    const files = readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.json'));
    assert(files.length <= 10000, 'too_many_reports');
    const runs = files.flatMap(f => { const item = parseJson(readFileSync(join(dir, f.name), 'utf8'), 262144);
      return Array.isArray(item.runs) ? item.runs : [item]; });
    print(summarize(runs)); return;
  }
  if (command === 'contract-export') {
    const rails = [];
    // Public, non-funded fixture recipients. No payloads or signatures created.
    for (const rail of RAILS) {
      const info = railInfo(rail, 'mainnet');
      const scheme = rail === 'base' ? new ExactEvmScheme() : rail === 'solana' ? new ExactSvmScheme() : new ExactAvmScheme();
      const parsed = await scheme.parsePrice('$0.001', info.network);
      const { OFFLINE_ADDRESSES } = await import('./config.js');
      rails.push({ rail, requirements: { scheme: 'exact', network: info.network, payTo: OFFLINE_ADDRESSES[rail],
        asset: parsed.asset, amount: parsed.amount, maxTimeoutSeconds: 60, extra: parsed.extra ?? {} } });
    }
    print({ fixture: true, sdk: '2.25.0', rails }); return;
  }
  if (command === 'demo') {
    const dir = mkdtempSync(join(tmpdir(), '402signal-lab-demo-'));
    const c = loadConfig('config/offline.json'); c.port = 0; c.ledgerPath = join(dir, 'seller.sqlite');
    const ledger = new Ledger(c.ledgerPath), spend = new Ledger(join(dir, 'buyer.sqlite'));
    const seller = new Seller(c, ledger), app = server(seller);
    try {
      await seller.initialize(); app.listen(0, '127.0.0.1'); await once(app, 'listening');
      const a = app.address(); assert(a && typeof a !== 'string', 'bind_failed'); c.origin = `http://127.0.0.1:${a.port}`;
      const buyerConfig = fixtureBuyerConfig(c);
      const buyer = new Buyer(buyerConfig, spend, fixtureSigner('demo'), fixtureRouter(seller, buyerConfig));
      const runs = [];
      for (const rail of RAILS) for (const name of UTILITIES) runs.push(await buyer.run(`demo-${rail}-${name.replace('/', '-')}`, rail, name));
      const report = { mode: 'offline', router: 'synthetic_in_process', seller: 'real_loopback_http_with_fake_facilitator',
        signatures: 'invalid_fixture_bytes', money_spent: '0', production_touched: false,
        runs, payments: ledger.summary(), all_deliveries_validated: runs.every(r => r.delivery === 'validated') };
      const out = flag('out');
      if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      print(report);
      if (runs.some(r => r.delivery !== 'validated')) process.exitCode = 1;
    } finally {
      if (app.listening) await new Promise<void>(resolve => { app.close(() => resolve()); app.closeAllConnections(); });
      ledger.close(); spend.close();
      // Only a freshly-created, explicitly owned demo directory is removed.
      rmSync(dir, { recursive: true });
    }
    return;
  }
  if (command === 'serve') {
    const c = loadConfig(flag('config')), ledger = new Ledger(c.ledgerPath), seller = new Seller(c, ledger);
    try { await seller.initialize(); } catch { ledger.close(); throw new LabError('seller_initialization_failed', 503); }
    const app = server(seller); app.listen(c.port, c.host); await once(app, 'listening');
    print({ listening: app.address(), mode: c.mode, traffic_class: 'self_test', public_directory_submission: false });
    const stop = () => { app.close(() => { ledger.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (command === 'faults') {
    const c = loadConfig('config/offline.json'); assert(c.mode === 'offline', 'faults_require_offline');
    const ledger = new Ledger(':memory:'), seller = new Seller(c, ledger); await seller.initialize();
    const { faultServer } = await import('./fault-server.js'); const app = faultServer(seller);
    app.listen(4022, '127.0.0.1'); await once(app, 'listening');
    print({ listening: 'http://127.0.0.1:4022', mode: 'offline', accepts_payments: false, submit_to_catalogs: false });
    const stop = () => app.close(() => { ledger.close(); process.exit(0); });
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (command === 'plan' || command === 'run' || command === 'run-seller') {
    const path = flag('config') ?? 'config/buyer.example.json';
    const c = validateBuyer(parseJson(readFileSync(path, 'utf8')));
    if (command === 'plan') {
      const routes = c.mode !== 'mainnet' || !!c.routePilot;
      print({ mode: c.mode, traffic_class: 'self_test', workflow: routes ? 'route_and_execute' : 'seller_only',
        run_command: c.mode === 'mainnet' ? (routes ? 'run-route' : 'run-seller') : 'run',
        router_max_atomic: routes ? '3000' : '0', seller_max_atomic: c.sellerMaxAtomic,
        max_per_run_atomic: ((routes ? 3000n : 0n) + BigInt(c.sellerMaxAtomic)).toString(),
        cap_atomic_per_rail: c.capAtomicPerRail, cap_scope: 'lifetime ledger, including failed and unknown attempts; gas excluded',
        signs_or_sends: false, blockers: c.mode === 'mainnet' ? [routes ? 'Mainnet route pilot; verify advertised production processing and pinned router terms.' : 'Seller-only mainnet pilot; router payment is bypassed.',
          'Fill dedicated public addresses, seller origin, RPCs and fee-payer pins. Run preflight.',
          'Set a small reviewed cap that covers the full reservation. Acknowledgements are required for each paid invocation.',
          'Buyer native fees must be zero. Account setup costs are separate. Unknown runs block the rail until reconciled.'] : ['Fill staging URLs and recipient/fee-payer allowlists.',
          'Use dedicated disposable testnet buyer keys in your own environment.', 'Router must explicitly support testnet; production 402Signal currently does not.',
          'Set nonzero reviewed caps and testnet-only execution acknowledgements.'] }); return;
    }
    const sellerOnly = command === 'run-seller';
    if (c.mode === 'mainnet') assert(sellerOnly,'mainnet_production_routing_not_enabled');
    const required = sellerOnly ? [c.sellerOrigin, c.sellerPayTo, c.feePayers] : c;
    assert(!JSON.stringify(required).includes('REPLACE') && !c.sellerOrigin.includes('.invalid') &&
      (sellerOnly || !c.routerUrl.includes('.invalid')), 'replace_buyer_placeholders');
    const id = flag('id'), rail = flag('rail') as Rail, name = flag('utility') as Utility;
    assert(id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) && RAILS.includes(rail) && UTILITIES.includes(name), 'explicit_run_arguments_required');
    const reportDirectory = flag('report-dir') ?? 'reports';
    mkdirSync(reportDirectory,{recursive:true,mode:0o700}); accessSync(reportDirectory,constants.W_OK);
    const reportPath = join(reportDirectory,id+'.json'); assert(!existsSync(reportPath),'report_already_exists');
    const { sdkSigner } = await import('./signer-sdk.js'); const signer = sdkSigner(c);
    const { confirmOnce } = await import('./confirmation.js');
    const ledger = new Ledger(c.ledgerPath);
    try {
      const result = await new Buyer(c, ledger, signer, undefined,
        c.mode === 'mainnet' ? (intent,transaction)=>confirmOnce(c.mainnet!,intent,transaction) : undefined).run(id, rail, name, sellerOnly);
      // Exclusive creation: never overwrite a previous report or reuse a run ID.
      writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      print(result); if (result.error) process.exitCode = 1;
    } finally { ledger.close(); }
    return;
  }
  throw new LabError('unknown_command');
}
main().catch(e => { print({ error: e instanceof LabError ? e.code : 'lab_operation_failed', retry_automatically: false }); process.exitCode = 1; });
