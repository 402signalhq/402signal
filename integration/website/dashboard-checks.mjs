import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

async function readableRows(page, prefix) {
  const observed = await page.locator('.lookups').evaluateAll(groups => groups.map(group => {
    const box = node => {
      const r = node.getBoundingClientRect();
      return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
    };
    const textBounds = node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map(r => ({left: r.left, right: r.right, top: r.top, bottom: r.bottom}));
    };
    return [...group.querySelectorAll('.lookup')].map(entry => {
      const [label, price] = entry.querySelectorAll('.lookup-row > span');
      const host = entry.querySelector('.lookup-host');
      return {entry: box(entry), label: box(label), price: box(price), host: box(host),
        text: label.textContent, priceText: price.textContent,
        textRects: [...textBounds(label), ...textBounds(price), ...textBounds(host)],
        clientWidth: entry.clientWidth, scrollWidth: entry.scrollWidth};
    });
  }));
  assert.equal(observed.length, 3, 'all three dashboard sections are populated');
  for (const entries of observed) {
    assert.equal(entries.length, 3, 'short, wrapping and unbroken labels are present');
    assert.ok(entries.some(entry => entry.priceText === 'unknown'));
    for (const [index, entry] of entries.entries()) {
      assert.ok(entry.text.startsWith(prefix), 'expected initial or refreshed data');
      const horizontalGap = entry.price.left - entry.label.right;
      const verticalGap = entry.price.top - entry.label.bottom;
      assert.ok(horizontalGap >= 8 || verticalGap >= 8,
        `name and price need visible separation: ${JSON.stringify(entry)}`);
      assert.ok(entry.host.top - Math.max(entry.label.bottom, entry.price.bottom) >= 3,
        'the host must not overlap the label or price');
      assert.ok(entry.scrollWidth <= entry.clientWidth + 1, 'a long label must not overflow its entry');
      for (const rect of entry.textRects) {
        assert.ok(rect.left >= entry.entry.left - 1 && rect.right <= entry.entry.right + 1,
          'all label, price and host text stays visible inside its entry');
        assert.ok(rect.top >= entry.entry.top - 1 && rect.bottom <= entry.entry.bottom + 1,
          'wrapped text must not be clipped');
      }
      if (index > 0) assert.ok(entry.entry.top - entries[index - 1].entry.bottom >= 8,
        'repeated entries need a visible gap');
    }
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  return observed;
}

export async function checkDashboardSpacing({page, origin, out, engine, width}) {
  const refreshed = await readFile(resolve(out, 'dashboard-refresh.json'), 'utf8');
  let release;
  const blocked = new Promise(resolve => {release = resolve;});
  const handler = async route => {
    await blocked;
    await route.fulfill({status: 200, contentType: 'application/json', body: refreshed});
  };
  await page.route('**/pulse', handler);
  try {
    // Hold the immediate poll so server HTML is checked before JS replaces it.
    await page.goto(origin + '/dashboard', {waitUntil: 'load'});
    await page.evaluate(() => document.fonts.ready);
    const initial = await readableRows(page, 'Initial');
    await page.screenshot({fullPage: true, path: resolve(out, `${engine}-${width}-dashboard-initial.png`)});
    await page.locator('#chain-base').screenshot({path: resolve(out, `${engine}-${width}-dashboard-initial-rows.png`)});
    release();
    await page.waitForFunction(() => document.querySelector('.lookup-row > span')?.textContent.startsWith('Updated'));
    const updated = await readableRows(page, 'Updated');
    await page.screenshot({fullPage: true, path: resolve(out, `${engine}-${width}-dashboard-refreshed.png`)});
    await page.locator('#chain-base').screenshot({path: resolve(out, `${engine}-${width}-dashboard-refreshed-rows.png`)});
    return {initial, updated};
  } finally {
    release();
    await page.unrouteAll({behavior: 'wait'});
  }
}
