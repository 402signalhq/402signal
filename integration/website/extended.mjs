import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium, webkit} from 'playwright';
import {checkDashboardSpacing} from './dashboard-checks.mjs';
import {checkTransparencySpacing} from './transparency-checks.mjs';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'website-evidence');
const results = JSON.parse(await readFile(resolve(out, 'results.json'), 'utf8'));
const exported = new Map([
  ['/transparency', 'transparency.html'], ['/transparency-confirmed', 'transparency-confirmed.html'],
  ['/dashboard', 'dashboard.html'],
  ['/route', 'route.html'], ['/pulse', 'pulse.json'],
]);
const statics = new Map([
  ['/', 'index.html'], ['/how', 'how.html'], ['/catalog', 'catalog.html'],
  ['/styles.css', 'styles.css'], ['/app.js', 'app.js'],
  ['/dashboard.js', 'dashboard.js'], ['/transparency.js', 'transparency.js'],
  ['/favicon.svg', 'favicon.svg'], ['/og.png', 'og.png'], ['/hero-routing.png', 'hero-routing.png'],
]);
const csp = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'";
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const name = exported.get(path) || statics.get(path);
  if (req.method !== 'GET' || !name) {res.writeHead(404); res.end(); return;}
  try {
    const bytes = await readFile(resolve(exported.has(path) ? out : resolve(root, 'live402/static'), name));
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.json') ? 'application/json' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.png') ? 'image/png' : 'text/html';
    res.writeHead(200, {'Content-Type': type + (type.startsWith('text/') ? '; charset=utf-8' : ''), 'Content-Security-Policy': csp});
    res.end(bytes);
  } catch {res.writeHead(500); res.end('Fixture export missing');}
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
async function check(name, fn) {
  try {await fn(); results.passed++; results.results.push({name, status: 'passed'}); console.log('PASS', name);}
  catch (error) {results.failed++; results.results.push({name, status: 'failed', error: String(error.stack).slice(0, 2000)}); console.error('FAIL', name, error);}
}
async function layout(page) {
  const value = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const bad = [];
    for (const node of document.querySelectorAll('main h1, main h2, main p, main input, main select, main button, .map-node, .nav')) {
      if (!node.getClientRects().length) continue;
      // A table/pre may intentionally scroll internally, not the whole page.
      if (node.closest('.table-scroll, .table-wrap, pre')) continue;
      const r = node.getBoundingClientRect();
      if (r.left < -1 || r.right > width + 1) bad.push({tag: node.tagName, id: node.id, cls: node.className, left: r.left, right: r.right, width});
    }
    return {width, scrollWidth: document.documentElement.scrollWidth, bad};
  });
  assert.ok(value.scrollWidth <= value.width + 1, JSON.stringify(value));
  assert.deepEqual(value.bad, [], JSON.stringify(value));
}
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({headless: true});
    try {
      for (const width of [320, 360, 375, 390, 414, 768, 1440]) {
        const context = await browser.newContext({viewport: {width, height: 844}, deviceScaleFactor: 2,
          isMobile: width < 700, hasTouch: width < 700, reducedMotion: 'reduce'});
        const errors = [], forbidden = [];
        await context.route('**/*', async route => {
          const request = route.request();
          if (new URL(request.url()).origin !== origin || request.method() !== 'GET') {
            forbidden.push(request.url()); await route.abort(); return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(String(error)));
        const tag = `${engine}/${width}/actual-rendered`;
        for (const path of ['/transparency', '/dashboard', '/route']) {
          await check(`${tag} ${path}`, async () => {
            const response = await page.goto(origin + path);
            assert.equal(response.status(), 200);
            await page.waitForLoadState('networkidle');
            assert.equal(await page.locator('h1').count(), 1);
            assert.equal(await page.locator('nav[aria-label="Primary"] a').count(), 4);
            await layout(page);
            if (width === 390) await page.screenshot({fullPage: true, path: resolve(out, `${engine}-390-${path.slice(1)}.png`)});
          });
        }
        if ([320, 375, 390, 1440].includes(width)) {
          await check(`${tag} transparency status and evidence spacing`, async () => {
            await checkTransparencySpacing({page, origin, out, engine, width});
          });
        }
        if ([320, 390, 1440].includes(width)) {
          await check(`${tag} initial and refreshed dashboard rows stay readable`, async () => {
            await checkDashboardSpacing({page, origin, out, engine, width});
          });
        }
        await check(`${tag} focus and readable mobile inputs`, async () => {
          await page.goto(origin + '/catalog');
          await page.keyboard.press('Tab');
          assert.equal(await page.locator('.skip-link').evaluate(node => node === document.activeElement), true);
          const button = page.locator('[data-network="base"]');
          await button.focus(); await page.keyboard.press('Space');
          assert.equal(await button.getAttribute('aria-pressed'), 'true');
          assert.equal(await button.evaluate(node => node === document.activeElement), true);
          const fontSize = await page.locator('#max-price').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
          assert.ok(fontSize >= 16);
          const target = await button.boundingBox();
          assert.ok(target.height >= 44 && target.width >= 44);
          await layout(page);
        });
        await check(`${tag} no external requests or page exceptions`, async () => {
          assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
        });
        if (width === 390) {
          await page.setViewportSize({width: 844, height: 390});
          for (const path of ['/', '/how', '/catalog', '/transparency']) {
            await check(`${engine}/landscape ${path}`, async () => {
              await page.goto(origin + path); await layout(page);
            });
          }
        }
        await context.close();
      }
    } finally {await browser.close();}
  }
} finally {
  await new Promise(done => server.close(done));
  results.scope = 'Chromium and WebKit responsive and mobile emulation, including actual fixture-server-rendered transparency/dashboard/route pages. Portrait widths 320–1440 and 844x390 landscape. No physical device, production data, paid request or external browser call.';
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
  await writeFile(resolve(out, 'summary.md'), `# Website qualification\n\n${results.passed} passed; ${results.failed} failed.\n\n${results.scope}\n\nScreenshots are generated in website-evidence. A passing geometry test is not a substitute for human visual review.\n`);
}
if (results.failed) process.exitCode = 1;
