import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium, webkit} from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'website-evidence');
await mkdir(out, {recursive:true});
const files = new Map([['/','index.html'],['/how','how.html'],['/catalog','catalog.html'],['/developers','developers.html'],['/contact','contact.html'],['/insights/pre-spend-routing','pre-spend-routing.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/favicon.svg','favicon.svg'],['/og.png','og.png'],['/hero-routing.png','hero-routing.png']]);
const csp = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'";
const server = createServer(async (req,res) => {
  try {
    const name = files.get(new URL(req.url,'http://127.0.0.1').pathname);
    if (req.method !== 'GET' || !name) {res.writeHead(404);res.end();return;}
    const bytes = await readFile(resolve(root,'live402/static',name));
    const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.png') ? 'image/png' : 'text/html';
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Content-Security-Policy':csp});res.end(bytes);
  } catch {res.writeHead(500);res.end('Missing fixture');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin = `http://127.0.0.1:${server.address().port}`;
const exactURL = 'https://seller.example/api/search?q=a%2Bb&z=1';
function catalogFixture() {
  return {not_probed:true,displayed:4,discovery_matches:8,discovery_exhaustive:false,hits:[
    {label:'Observed search API',url:exactURL,price:'$0.010',chain:'base',scheme:'exact',source:'Synthetic catalog',method:'GET',inputSchema_present:true,observation:{status:'observed',last_checked:new Date(Date.now()-172800000).toISOString(),payable:true,invocable:true,n_7d:3,last_latency_ms:140}},
    {label:'Session cap, not fixed call price',url:'https://seller.example/session',price:'Up to $0.001 USDC',scheme:'upto',chain:'solana',observation:{status:'not_yet_observed'}},
    {label:'<img src=x onerror="window.sellerInjected=true">',url:'https://seller.example/cheap',price:'$0.001',scheme:'exact',chain:'algorand',observation:{status:'not_yet_observed'}},
    {label:'Long endpoint '+ 'x'.repeat(130),url:'https://seller.example/'+'x'.repeat(200),price:'',chain:'base',observation:{status:'not_yet_observed'}},
  ]};
}
const results = {passed:0,failed:0,results:[]};
async function check(name,fn) {
  try {await fn(); results.passed++; results.results.push({name,status:'passed'});console.log('PASS',name);}
  catch(error) {results.failed++;results.results.push({name,status:'failed',error:String(error.stack||error).slice(0,2200)});console.error('FAIL',name,error);}
}
async function noOverflow(page,label) {
  const geometry = await page.evaluate(()=>{
    const width=document.documentElement.clientWidth,bad=[];
    for(const node of document.querySelectorAll('main h1, main h2, main p, main input, main select, main button, .map-node, .offer-preview, .result-row, .nav')) {
      if(!node.getClientRects().length || node.closest('.table-scroll, .table-wrap, pre')) continue;
      const r=node.getBoundingClientRect();
      if(r.left < -1 || r.right > width+1) bad.push({tag:node.tagName,id:node.id,left:r.left,right:r.right});
    }
    return {width,scrollWidth:document.documentElement.scrollWidth,bad};
  });
  assert.ok(geometry.scrollWidth <= geometry.width+1, label+JSON.stringify(geometry));
  assert.deepEqual(geometry.bad,[],label+JSON.stringify(geometry));
}
async function search(page,q='web search') {
  await page.locator('#need').fill(q); await page.locator('#search-btn').click();
  await page.locator('#search-status').filter({hasText:'Catalog response received'}).waitFor();
}
async function advanced(page) {
  const detail=page.locator('details.policy-advanced');
  if(!await detail.evaluate(node=>node.open)) await detail.locator('summary').click();
}
try {
  for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await launcher.launch({headless:true});
    try {
      for(const width of [320,360,375,390,414,768,1440]) {
        const context=await browser.newContext({viewport:{width,height:width<700?844:1000},deviceScaleFactor:1,hasTouch:width<700,reducedMotion:'reduce'});
        const errors=[],forbidden=[],requests=[];
        await context.addInitScript(()=>{
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedFixtureText=value;}}});
          window.sellerInjected=false;
        });
        await context.route('**/*',async route=>{
          const request=route.request(),url=new URL(request.url());
          requests.push({path:url.pathname,method:request.method(),url:request.url()});
          if(url.origin!==origin||request.method()!=='GET') {forbidden.push(request.url());await route.abort();return;}
          if(url.pathname==='/pulse') {await route.fulfill({status:200,contentType:'application/json',body:'{"index_status":"refreshing"}'});return;}
          if(url.pathname==='/preview') {
            const q=url.searchParams.get('need');
            if(q==='limited'||q==='unavailable') {await route.fulfill({status:q==='limited'?429:503,contentType:'application/json',body:'{}'});return;}
            if(q==='malformed') {await route.fulfill({status:200,contentType:'application/json',body:'{broken'});return;}
            const body=catalogFixture();
            if(q==='empty') body.hits=[];
            if(q==='slow') {await new Promise(done=>setTimeout(done,250));body.hits[0].label='Obsolete slow result';}
            if(q==='fast') body.hits[0].label='Current fast result';
            try {await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});} catch {/* canceled older response */}
            return;
          }
          if(url.pathname==='/validate') {
            const selected=url.searchParams.get('url');
            const endpoint=new URL(selected);
            if(endpoint.pathname==='/limited') {await route.fulfill({status:429,contentType:'application/json',body:'{}'});return;}
            if(endpoint.pathname==='/malformed') {await route.fulfill({status:200,contentType:'application/json',body:'[]'});return;}
            const body={url:selected,payable:true,invocable:true,verified_at:'2026-09-08T12:00:00Z',observed:{http_status:402,payTo:'<img src=x onerror="window.sellerInjected=true">'},flags:['missing schema']};
            if(endpoint.pathname==='/unlisted') {body.miss_reason='no_candidates';body.payable=false;body.observed={};}
            if(endpoint.pathname==='/mismatch') body.url='https://different.example/api';
            if(endpoint.pathname==='/slow') await new Promise(done=>setTimeout(done,250));
            try {await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});} catch {/* explicit edit invalidated old response */}
            return;
          }
          await route.continue();
        });
        const page=await context.newPage();page.setDefaultTimeout(10000);
        page.on('pageerror',e=>errors.push(String(e)));
        const tag=`${engine}/${width}`;
        for(const path of ['/','/how','/catalog','/developers','/contact','/insights/pre-spend-routing']) {
          await check(`${tag} layout ${path}`,async()=>{
            const response=await page.goto(origin+path);assert.equal(response.status(),200);
            assert.equal(await page.locator('h1').count(),1);
            assert.equal(await page.locator('nav[aria-label="Primary"] a').count(),5);
            await noOverflow(page,path);
          });
        }
        await check(`${tag} spaced diagram and no-payment demo`,async()=>{
          await page.goto(origin+'/how');
          assert.deepEqual(await page.locator('.map-node strong').allTextContents(),['Set the request and spending rules','Observe the API and check its terms','Verify the evidence. Proceed or stop.']);
          assert.equal(await page.locator('.map-node strong br').count(),0);
          await page.waitForLoadState('networkidle');const count=requests.length;
          for(const [state,label,fee] of [['same','Offer matches','$0.003'],['price','Stop: price changed','$0.003'],['recipient','Stop: recipient changed','$0.003'],['expired','Stop: evidence expired','$0.003'],['miss','No qualifying offer','$0']]) {
            await page.locator('#demo-scenario').selectOption(state);
            assert.equal(await page.locator('#demo-result').innerText(),label);
            assert.equal(await page.locator('#demo-fee').innerText(),fee);await noOverflow(page,state);
          }
          assert.equal(requests.length,count);
        });
        await check(`${tag} catalog sorting filters and exact endpoint`,async()=>{
          await page.goto(origin+'/catalog');await search(page);
          assert.equal(await page.locator('.result-row').count(),4);
          assert.match(await page.locator('.result-row').first().innerText(),/Last observed 2 days ago/);
          assert.equal(await page.locator('#search-results img').count(),0);
          assert.equal(await page.evaluate(()=>window.sellerInjected),false);
          await noOverflow(page,'populated catalog');
          await page.locator('#display-sort').selectOption('price');
          assert.match(await page.locator('.result-row').first().innerText(),/<img src=x/);
          await page.locator('#display-filter').selectOption('observed');assert.equal(await page.locator('.result-row').count(),1);
          await page.locator('.result-row button').filter({hasText:'Build check request'}).click();
          const body=JSON.parse(await page.locator('#route-json').innerText());
          assert.equal(body.url,exactURL);assert.equal(body.need,undefined);assert.equal(body.require_route_binding,true);
          await page.locator('#copy-route-json').click();assert.equal(JSON.parse(await page.evaluate(()=>window.copiedFixtureText)).url,exactURL);
          assert.ok(!requests.some(r=>r.path==='/validate'),'Catalog must not probe automatically');
          await noOverflow(page,'exact builder');
        });
        await check(`${tag} invalid limits and shell-safe subcent requests`,async()=>{
          await page.goto(origin+'/catalog');await page.locator('#need').fill("weather's $(no_command)");
          await page.locator('#max-price').fill('0.001');let body=JSON.parse(await page.locator('#route-json').innerText());assert.equal(body.max_price_usd,.001);
          await page.locator('#copy-route-curl').click();assert.ok((await page.evaluate(()=>window.copiedFixtureText)).includes("'\\''"));
          for(const invalid of ['-1','1e3','NaN','1.0000001']) {
            await page.locator('#max-price').fill(invalid);assert.equal(await page.locator('#copy-route-json').isDisabled(),true);assert.equal(await page.locator('#copy-route-curl').isDisabled(),true);assert.equal(await page.locator('#max-price').getAttribute('aria-invalid'),'true');
          }
          await page.locator('#max-price').fill('0');body=JSON.parse(await page.locator('#route-json').innerText());assert.equal(body.max_price_usd,0);
          await page.locator('#max-price').fill('');body=JSON.parse(await page.locator('#route-json').innerText());assert.equal(body.max_price_usd,undefined);
          await advanced(page);await page.locator('#min-observations').fill('1.5');assert.equal(await page.locator('#copy-route-json').isDisabled(),true);
          await page.locator('#min-observations').fill('3');await page.locator('#require-binding').uncheck();assert.match(await page.locator('#binding-help').innerText(),/will reject an unbound response/);
          await noOverflow(page,'limits');
        });
        await check(`${tag} guide selection and meaningful copy`,async()=>{
          await page.goto(origin+'/developers');assert.equal(await page.locator('#quickstart').isVisible(),true);assert.equal(await page.locator('#sellers').isVisible(),false);
          for(const id of ['route-binding','native-mpp','batch-support','recovery','interfaces','policy-guide','pq-trust','compatibility','quickstart']) {
            await page.locator(`[data-guide-link="${id}"]`).click();
            await page.locator(`#${id}`).waitFor({state:'visible'});
            assert.equal(await page.locator('[data-guide]:visible').count(),1);await noOverflow(page,id);
          }
          await page.locator('#quickstart details summary').click();
          await page.locator('[data-copy-target="brief-quickstart"]').click();
          assert.match(await page.evaluate(()=>window.copiedFixtureText),/node integration\/buyer-checks\/run.mjs/);
          await page.goto(origin+'/developers#request');assert.equal(await page.locator('#route-binding').isVisible(),true);
          await page.goBack();
        });
        await check(`${tag} explicit free seller readiness and untrusted data`,async()=>{
          const before=requests.filter(r=>r.path==='/validate').length;
          await page.goto(origin+'/developers?endpoint='+encodeURIComponent(exactURL)+'#sellers');
          assert.equal(await page.locator('#seller-url').inputValue(),exactURL);
          assert.equal(requests.filter(r=>r.path==='/validate').length,before,'Prefill cannot submit');
          await page.locator('#seller-check').click();await page.locator('#seller-status').filter({hasText:'Readiness response received'}).waitFor();
          assert.equal(requests.filter(r=>r.path==='/validate').length,before+1);
          const request=requests.filter(r=>r.path==='/validate').at(-1);assert.equal(new URL(request.url).searchParams.get('url'),exactURL);
          assert.equal(await page.locator('#seller-result img').count(),0);assert.equal(await page.evaluate(()=>window.sellerInjected),false);
          assert.match(await page.locator('#seller-result').innerText(),/not established by this result/);await noOverflow(page,'seller result');
          await page.locator('#seller-url').fill('https://seller.example/unlisted');await page.locator('#seller-check').click();
          await page.locator('#seller-status').filter({hasText:'No seller probe was made'}).waitFor();assert.match(await page.locator('#seller-status').innerText(),/does not show.*offline/);
          for(const invalid of ['https://user:pass@seller.example/path','http://seller.example/path','https://seller.example/path#private']) {
            await page.locator('#seller-url').fill(invalid);assert.equal(await page.locator('#seller-check').isDisabled(),true);
          }
        });
        if(width===390) {
          await check(`${tag} catalog errors and stale response ordering`,async()=>{
            await page.goto(origin+'/catalog');
            for(const [query,pattern] of [['limited',/Too many searches/],['unavailable',/refreshing/],['malformed',/Could not load/]]) {
              await page.locator('#need').fill(query);await page.locator('#search-btn').click();
              await page.waitForFunction(()=>document.getElementById('search-results').getAttribute('aria-busy')==='false');
              assert.match(await page.locator('#search-status').innerText(),pattern);
            }
            await search(page,'empty');assert.match(await page.locator('#search-results').innerText(),/No catalog matches/);
            await page.locator('#need').fill('slow');await page.locator('#search-btn').click();await page.locator('#need').fill('fast');await page.locator('#search-btn').click();
            await page.locator('#search-status').filter({hasText:'Catalog response received'}).waitFor();await page.waitForTimeout(350);
            assert.match(await page.locator('.result-row').first().innerText(),/Current fast result/);
          });
          await check(`${tag} seller errors and edits invalidate prior response`,async()=>{
            await page.goto(origin+'/developers#sellers');
            for(const [path,pattern] of [['limited',/Rate limit/],['malformed',/unreadable/],['mismatch',/mismatched/]]) {
              await page.locator('#seller-url').fill('https://seller.example/'+path);await page.locator('#seller-check').click();
              await page.waitForFunction(()=>document.getElementById('seller-result').getAttribute('aria-busy')==='false');assert.match(await page.locator('#seller-status').innerText(),pattern);
            }
            await page.locator('#seller-url').fill('https://seller.example/slow');await page.locator('#seller-check').click();
            await page.locator('#seller-url').fill(exactURL);await page.waitForTimeout(350);
            assert.equal(await page.locator('#seller-result').innerText(),'');assert.match(await page.locator('#seller-status').innerText(),/Submit to check/);
          });
        }
        if([390,1440].includes(width)) {
          for(const [path,name] of [['/','home'],['/how#trust','trust'],['/developers#quickstart','developers'],['/catalog','catalog']]) {
            await page.goto(origin+path);if(path==='/catalog') await search(page);
            await page.screenshot({fullPage:true,path:resolve(out,`${engine}-${width}-${name}.png`)});
            if(engine==='chromium') await page.screenshot({type:'jpeg',quality:48,path:resolve(out,`review-${width}-${name}.jpg`)});
          }
        }
        await check(`${tag} no exceptions external calls or payments`,async()=>{
          assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);assert.ok(requests.every(r=>r.method==='GET'));assert.ok(!requests.some(r=>r.path==='/route'));
        });
        await context.close();
      }
      const nojs=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
      await check(`${engine} no-script documentation remains readable`,async()=>{
        const page=await nojs.newPage();await page.goto(origin+'/developers');
        assert.ok(await page.locator('[data-guide]:visible').count()>=9);await noOverflow(page,'no-js guides');
      });
      await nojs.close();
    } finally {await browser.close();}
  }
} finally {
  await new Promise(done=>server.close(done));
  results.scope='Chromium and WebKit at widths 320, 360, 375, 390, 414, 768 and 1440. Static source under the production CSP. Synthetic catalog and readiness only; no production wallet or payments.';
  await writeFile(resolve(out,'results.json'),JSON.stringify(results,null,2));
  await writeFile(resolve(out,'summary.md'),`# Customer site tests\n\n${results.passed} passed; ${results.failed} failed.\n\n${results.scope}\n`);
}
if(results.failed)process.exitCode=1;
