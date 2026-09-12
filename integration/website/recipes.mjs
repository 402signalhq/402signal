import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'website-evidence');
const exports=JSON.parse(await readFile(resolve(out,'exports.json'),'utf8'));
const recipes=Object.keys(exports).filter(p=>p.startsWith('/developers/'));
assert.equal(recipes.length,13);
const staticFiles=new Map([['/','index.html'],['/developers','developers.html'],['/app.js','app.js'],['/styles.css','styles.css'],['/favicon.svg','favicon.svg']]);
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 const file=exports[path] ? resolve(out,exports[path]) : staticFiles.has(path) ? resolve(root,'live402/static',staticFiles.get(path)) : null;
 if(req.method!=='GET'||!file){res.writeHead(404);res.end();return;}
 const type=path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html';
 res.writeHead(200,{'Content-Type':type,'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"});res.end(await readFile(file));
}catch{res.writeHead(500);res.end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port;
const results=[];
try{for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch({headless:true});
 try{for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text;}}}));
  const page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  for(const path of recipes){
   await page.goto(origin+path);assert.equal(await page.locator('h1').count(),1);
   assert.equal(await page.locator('[data-guide]:visible').count(),1);
   assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'),'https://402signal.com'+path);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').innerText(),'Skip to content');
   const brief=page.locator('.agent-brief');
   if(await brief.count()){
    await brief.locator('summary').click();await brief.locator('[data-copy-target]').click();
    assert.ok((await page.evaluate(()=>window.copied)).length>100);
   }
   if(path.endsWith('/check-api-listing')){
    await page.locator('#seller-url').fill('https://seller.example/'+ 'long-query-'.repeat(40)+'?q=a%2Bb');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.ok(!requests.some(u=>u.includes('/validate')));
   }
   await page.screenshot({path:resolve(out,`recipe-${engine}-${width}-${path.split('/').pop()}.png`),fullPage:true});
   results.push({engine,width,path,status:'passed'});
  }
  await page.goto(origin+'/');assert.ok(await page.getByRole('link',{name:'Building a payment client? Run the free offline checks.'}).isVisible());
  await page.screenshot({path:resolve(out,`adoption-home-${engine}-${width}.png`),fullPage:true});
  await page.goto(origin+'/developers#request');assert.ok(await page.locator('#route-binding').isVisible());
  for (const id of ['quickstart','route-binding','hosted-session','native-mpp','check-group-offer','batch-support','sellers','recovery','seller-recovery','interfaces','pq-trust','policy-guide','compatibility']) { await page.locator('[data-guide-link="'+id+'"]').click(); await page.locator('#'+id).waitFor({state:'visible'}); assert.ok(await page.locator('#'+id).isVisible()); assert.equal(await page.locator('[data-guide]:visible').count(),1); }
  await page.goto(origin+'/developers#seller-recovery');assert.ok(await page.locator('#seller-recovery').isVisible());
  await page.screenshot({path:resolve(out,`adoption-index-${engine}-${width}.png`),fullPage:true});
  assert.deepEqual(errors,[]);assert.ok(!requests.some(u=>u.includes('/route?')||u.endsWith('/route')||u.includes('/validate')));
  await context.close();
 }
 const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:900}});
 const page=await context.newPage();for(const path of recipes){await page.goto(origin+path);assert.ok(await page.locator('[data-guide]').isVisible());}
  await page.goto(origin+'/developers');assert.equal(await page.locator('[data-guide]:visible').count(),13);await context.close();
 }finally{await browser.close();}
}}finally{await new Promise(done=>server.close(done));await writeFile(resolve(out,'recipe-results.json'),JSON.stringify(results,null,2));}
console.log('Permanent recipe browser checks:',results.length,'passed; screenshots retained, no payments or seller probes.');
