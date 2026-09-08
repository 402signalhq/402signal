import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'website-evidence');
await mkdir(output, {recursive: true});
const files = new Map([
  ['/', 'index.html'], ['/catalog', 'catalog.html'], ['/how', 'how.html'],
  ['/developers', 'developers.html'], ['/contact', 'contact.html'],
  ['/insights/pre-spend-routing', 'pre-spend-routing.html'], ['/route', 'route.html'],
  ['/styles.css', 'styles.css'], ['/app.js', 'app.js'], ['/favicon.svg', 'favicon.svg'],
  ['/og.png', 'og.png'], ['/hero-routing.png', 'hero-routing.png'],
]);
const csp = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'";
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const file = files.get(path);
    if (req.method !== 'GET' || !file) { res.writeHead(404); res.end(); return; }
    const data = await readFile(resolve(root, 'live402/static', file));
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html';
    res.writeHead(200, {'Content-Type': type + (type.startsWith('text/') ? '; charset=utf-8' : ''), 'Content-Security-Policy': csp, 'Cache-Control': 'no-store'});
    res.end(data);
  } catch { res.writeHead(500); res.end('Fixture failure'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const exactURL = 'https://seller.example/api/search?q=a%2Bb&z=1';
const fixtures = () => ({not_probed: true, displayed: 4, discovery_matches: 8, discovery_exhaustive: false, hits: [
  {label: 'Observed search API', url: exactURL, price: '$0.010', chain: 'base', scheme: 'exact', source: 'Synthetic catalog', method: 'GET', inputSchema_present: true, observation: {status: 'observed', last_checked: new Date(Date.now() - 172800000).toISOString(), payable: true, invocable: true, n_7d: 3, last_latency_ms: 140}},
  {label: 'Session ceiling, not a fixed price', url: 'https://seller.example/session', price: 'Up to $0.001 USDC', scheme: 'upto', chain: 'solana', observation: {status: 'not_yet_observed'}},
  {label: '<img src=x onerror="window.sellerInjected=true">', url: 'https://seller.example/cheap', price: '$0.001', chain: 'algorand', scheme: 'exact', observation: {status: 'not_yet_observed'}},
  {label: 'Long endpoint ' + 'x'.repeat(130), url: 'https://seller.example/' + 'x'.repeat(200), price: '', chain: 'base', observation: {status: 'not_yet_observed'}},
]});
const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push({name, status: 'passed'}); console.log('PASS', name); }
  catch (error) { failures++; results.push({name, status: 'failed', error: String(error.stack || error).slice(0, 2500)}); console.error('FAIL', name, error); }
}
async function noOverflow(page, label) {
  const geometry = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const failures = [];
    for (const node of document.querySelectorAll('main h1, main h2, main p, main input, main select, main button, .map-node, .map-node strong, .offer-preview, .result-row, .nav')) {
      if (!node.getClientRects().length) continue;
      const r = node.getBoundingClientRect();
      if (r.left < -1 || r.right > width + 1) failures.push({tag: node.tagName, id: node.id, cls: node.className, left: r.left, right: r.right, width});
    }
    return {width, scrollWidth: document.documentElement.scrollWidth, failures};
  });
  assert.ok(geometry.scrollWidth <= geometry.width + 1, `${label}: document overflows ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.failures, [], `${label}: element outside viewport`);
}
async function search(page, value = 'web search') {
  await page.locator('#need').fill(value);
  await page.locator('#search-btn').click();
  await page.locator('#search-status').filter({hasText: 'Catalog response received'}).waitFor();
}
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({headless: true});
    try {
      for (const width of [320, 360, 375, 390, 414, 768, 1440]) {
        const context = await browser.newContext({viewport: {width, height: width < 700 ? 844 : 1000}, deviceScaleFactor: 1, hasTouch: width < 700, reducedMotion: 'reduce'});
        const violations = [], errors = [], requests = [];
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async text => { window.copiedFixtureText = text; }}});
          window.sellerInjected = false;
        });
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          requests.push({method: request.method(), path: url.pathname});
          if (url.origin !== origin || request.method() !== 'GET') { violations.push(request.url()); await route.abort(); return; }
          if (url.pathname === '/preview') {
            const q = url.searchParams.get('need');
            if (q === 'limited') { await route.fulfill({status: 429, contentType: 'application/json', body: '{}'}); return; }
            if (q === 'unavailable') { await route.fulfill({status: 503, contentType: 'application/json', body: '{}'}); return; }
            if (q === 'malformed') { await route.fulfill({status: 200, contentType: 'application/json', body: '{broken'}); return; }
            const response = fixtures();
            if (q === 'empty') response.hits = [];
            if (q === 'slow') { await new Promise(done => setTimeout(done, 250)); response.hits[0].label = 'Obsolete slow result'; }
            if (q === 'fast') response.hits[0].label = 'Current fast result';
            try { await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(response)}); } catch { /* Superseded aborted fixture request. */ }
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(String(error)));
        const tag = `${engine}/${width}`;
        for (const path of ['/', '/how', '/catalog', '/developers', '/contact', '/insights/pre-spend-routing']) {
          await check(`${tag} layout ${path}`, async () => {
            const response = await page.goto(origin + path);
            assert.equal(response.status(), 200);
            assert.equal(await page.locator('h1').count(), 1);
            await noOverflow(page, path);
            const nav = page.locator('nav[aria-label="Primary"]');
            assert.equal(await nav.locator('a').count(), 4);
          });
        }
        await check(`${tag} spaced flow captions and simulated outcomes`, async () => {
          await page.goto(origin + '/how');
          const captions = await page.locator('.map-node strong').allTextContents();
          assert.deepEqual(captions, ['Set the request and spending rules', 'Observe the API and check its terms', 'Verify the evidence. Proceed or stop.']);
          assert.equal(await page.locator('.map-node strong br').count(), 0);
          const before = requests.length;
          for (const [value, expected, fee] of [['same', 'Offer matches', '$0.003'], ['price', 'Stop: price changed', '$0.003'], ['recipient', 'Stop: recipient changed', '$0.003'], ['expired', 'Stop: evidence expired', '$0.003'], ['miss', 'No qualifying offer', '$0']]) {
            await page.locator('#demo-scenario').selectOption(value);
            assert.equal(await page.locator('#demo-result').innerText(), expected);
            assert.equal(await page.locator('#demo-fee').innerText(), fee);
            await noOverflow(page, `demo ${value}`);
          }
          assert.equal(requests.length, before, 'The demonstration must not fetch, sign or pay');
        });
        await check(`${tag} catalog provenance, sorting, filters and exact endpoint`, async () => {
          await page.goto(origin + '/catalog'); await search(page);
          assert.equal(await page.locator('.result-row').count(), 4);
          assert.match(await page.locator('.result-row').first().innerText(), /Last observed 2 days ago/);
          assert.equal(await page.locator('#search-results img').count(), 0);
          assert.equal(await page.evaluate(() => window.sellerInjected), false);
          await noOverflow(page, 'catalog populated');
          await page.locator('#display-sort').selectOption('price');
          assert.match(await page.locator('.result-row').first().innerText(), /<img src=x/);
          await page.locator('#display-filter').selectOption('observed');
          assert.equal(await page.locator('.result-row').count(), 1);
          await page.locator('.result-row button').filter({hasText: 'Check this endpoint'}).click();
          const request = JSON.parse(await page.locator('#route-json').innerText());
          assert.equal(request.url, exactURL);
          assert.equal(request.need, undefined);
          assert.equal(request.require_route_binding, true);
          await page.locator('#copy-route-json').click();
          assert.equal(JSON.parse(await page.evaluate(() => window.copiedFixtureText)).url, exactURL);
          await noOverflow(page, 'direct endpoint builder');
        });
        await check(`${tag} invalid limits never disappear and sub-cent values work`, async () => {
          await page.goto(origin + '/catalog'); await page.locator('#need').fill("weather's $(no_command)");
          await page.locator('#max-price').fill('0.001');
          let request = JSON.parse(await page.locator('#route-json').innerText());
          assert.equal(request.max_price_usd, .001); assert.equal(request.require_route_binding, true);
          await page.locator('#copy-route-curl').click();
          const curl = await page.evaluate(() => window.copiedFixtureText);
          assert.ok(curl.includes("'\\''"), 'POSIX quote escaped');
          for (const invalid of ['-1', '1e3', 'NaN', '1.0000001']) {
            await page.locator('#max-price').fill(invalid);
            assert.equal(await page.locator('#copy-route-json').isDisabled(), true);
            assert.equal(await page.locator('#copy-route-curl').isDisabled(), true);
            assert.equal(await page.locator('#max-price').getAttribute('aria-invalid'), 'true');
          }
          await page.locator('#max-price').fill('0');
          request = JSON.parse(await page.locator('#route-json').innerText()); assert.equal(request.max_price_usd, 0);
          await page.locator('#max-price').fill('');
          request = JSON.parse(await page.locator('#route-json').innerText()); assert.equal(request.max_price_usd, undefined);
          await page.locator('#min-observations').fill('1.5'); assert.equal(await page.locator('#copy-route-json').isDisabled(), true);
          await page.locator('#min-observations').fill('3');
          await page.locator('#require-binding').uncheck();
          assert.match(await page.locator('#binding-help').innerText(), /will reject an unbound response/);
          await noOverflow(page, 'invalid constraints');
        });
        if (width === 390) {
          await check(`${tag} errors are not mistaken for catalog refresh or payment`, async () => {
            await page.goto(origin + '/catalog');
            for (const [q, pattern] of [['limited', /Too many searches/], ['unavailable', /unavailable or refreshing/], ['malformed', /Could not load/]]) {
              await page.locator('#need').fill(q); await page.locator('#search-btn').click();
              await page.waitForFunction(() => document.getElementById('search-results').getAttribute('aria-busy') === 'false');
              assert.match(await page.locator('#search-status').innerText(), pattern);
            }
            await search(page, 'empty'); assert.match(await page.locator('#search-results').innerText(), /No catalog matches/);
          });
          await check(`${tag} newer search cannot be replaced by a slow response`, async () => {
            await page.goto(origin + '/catalog');
            await page.locator('#need').fill('slow'); await page.locator('#search-btn').click();
            await page.locator('#need').fill('fast'); await page.locator('#search-btn').click();
            await page.locator('#search-status').filter({hasText: 'Catalog response received'}).waitFor();
            await page.waitForTimeout(350);
            assert.match(await page.locator('.result-row').first().innerText(), /Current fast result/);
          });
          for (const path of ['/how', '/catalog']) {
            await page.goto(origin + path);
            if (path === '/catalog') await search(page);
            const shot = await page.screenshot({fullPage: true});
            const name = `${engine}-390-${path.slice(1)}.png`;
            await writeFile(resolve(output, name), shot);
            console.log('SCREENSHOT', name, 'sha256=' + createHash('sha256').update(shot).digest('hex'));
          }
        }
        await check(`${tag} no script exceptions or external/payment calls`, async () => {
          assert.deepEqual(errors, []); assert.deepEqual(violations, []);
          assert.ok(requests.every(request => request.method === 'GET'));
          assert.ok(!requests.some(request => request.path === '/route' || request.path === '/validate'));
        });
        await context.close();
      }
    } finally { await browser.close(); }
  }
} finally {
  await new Promise(done => server.close(done));
  await writeFile(resolve(output, 'results.json'), JSON.stringify({passed: results.length - failures, failed: failures, scope: 'Chromium and WebKit responsive browser emulation. Static source pages under production-equivalent CSP; synthetic catalog only. No physical device, paid request or production deployment.', results}, null, 2));
  await writeFile(resolve(output, 'summary.md'), `# Website browser qualification\n\n${results.length - failures} passed; ${failures} failed.\n\nChromium and WebKit at 320, 360, 375, 390, 414, 768 and 1440 CSS pixels. Synthetic catalog data only. The sample interaction performs no network requests. This is browser emulation, not a physical-device test or a production payment test.\n`);
}
if (failures) process.exitCode = 1;
