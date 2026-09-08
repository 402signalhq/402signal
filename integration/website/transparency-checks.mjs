import assert from 'node:assert/strict';
import {resolve} from 'node:path';

export async function checkTransparencySpacing({page, origin, out, engine, width}) {
  const observations = [];
  for (const [path, state] of [['/transparency', 'awaiting'], ['/transparency-confirmed', 'confirmed']]) {
    await page.goto(origin + path, {waitUntil: 'networkidle'});
    const measured = await page.evaluate(() => {
      const rect = node => {
        const r = node.getBoundingClientRect();
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
      };
      const badges = [...document.querySelectorAll('.hero .pq-status-row > p')].map(node => ({...rect(node), text: node.textContent}));
      const boundary = document.querySelector('#anchor-boundary');
      const latest = document.querySelector('#latest-confirmed h2');
      const labels = [...document.querySelectorAll('.confirm-card > .pq-kicker')];
      const fields = labels.map(node => ({label: rect(node), value: rect(node.nextElementSibling), name: node.textContent}));
      const cards = [...document.querySelectorAll('.history-card')].filter(node => node.getClientRects().length).map(node => ({...rect(node), paragraphs: [...node.querySelectorAll('p')].map(rect)}));
      return {badges, fields, cards, boundaryGap: rect(latest).top - rect(boundary).bottom,
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth};
    });
    const issues = [];
    const demand = (condition, message) => {if (!condition) issues.push(message);};
    demand(measured.badges.length === 2, 'both status badges are present');
    if (measured.badges.length === 2) {
      const [network, status] = measured.badges;
      demand(network.text === 'Algorand MainNet', 'MainNet badge fixture');
      demand(status.text === (state === 'confirmed' ? 'Confirmed' : 'Awaiting anchor'), 'checkpoint status fixture');
      demand(Math.abs(network.top - status.top) <= 1 && Math.abs(network.bottom - status.bottom) <= 1,
        'status badges must share a baseline and equal vertical bounds');
      demand(status.left - network.right >= 8, 'status badges need horizontal separation');
    }
    demand(measured.boundaryGap >= 24, 'scope note needs separation from the next section heading');
    if (state === 'confirmed') {
      demand(measured.fields.length === 6, 'all confirmed checkpoint fields are present');
      for (const [index, field] of measured.fields.entries()) {
        if (width <= 640) {
          const gap = field.value.top - field.label.bottom;
          demand(gap >= 4 && gap <= 10, 'mobile checkpoint label/value gap must remain compact: ' + field.name);
          if (index > 0) demand(field.label.top - measured.fields[index - 1].value.bottom >= 16,
            'separate checkpoint fields must remain distinguishable');
        } else demand(field.value.left - field.label.right >= 12, 'desktop checkpoint columns must not overlap');
      }
      if (width <= 720) {
        demand(measured.cards.length === 2, 'both mobile history entries are present');
        for (const [index, card] of measured.cards.entries()) {
          if (index > 0) demand(card.top - measured.cards[index - 1].bottom >= 12,
            'consecutive mobile history entries need visible separation');
          for (let i = 1; i < card.paragraphs.length; i++) {
            const gap = card.paragraphs[i].top - card.paragraphs[i - 1].bottom;
            demand(gap >= 4 && gap <= 10, 'history fields must group compactly within an entry');
          }
        }
      } else demand(measured.cards.length === 0, 'desktop keeps its existing history table');
    }
    demand(measured.scrollWidth <= measured.width + 1, 'no page overflow');
    await page.locator('.hero .pq-status-row').screenshot({path: resolve(out, `${engine}-${width}-transparency-${state}-badges.png`)});
    if (state === 'confirmed') {
      await page.locator('#latest-confirmed').screenshot({path: resolve(out, `${engine}-${width}-transparency-checkpoint.png`)});
      if (width <= 720) await page.locator('.history-cards').screenshot({path: resolve(out, `${engine}-${width}-transparency-history.png`)});
      await page.locator('#anchor-boundary').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo(0, document.querySelector('#anchor-boundary').getBoundingClientRect().top + scrollY - 12));
      await page.screenshot({path: resolve(out, `${engine}-${width}-transparency-section-spacing.png`)});
    }
    observations.push({state, measured, issues});
  }
  assert.deepEqual(observations.flatMap(item => item.issues.map(issue => item.state + ': ' + issue)), [], JSON.stringify(observations));
  return observations;
}
