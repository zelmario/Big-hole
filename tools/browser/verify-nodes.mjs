/**
 * The many-node case, in a real browser: chart timezone and legend legibility.
 *
 * Both were reported against a real nine-member bundle, and neither is visible to jsdom --
 * one is what uPlot does with a `Date` on a canvas, the other is what CSS does with a panel
 * that has nine series in it.
 *
 * Runs with TZ deliberately set away from UTC (the container inherits it), because a chart
 * axis in local time and a chart axis in UTC are indistinguishable when they are the same
 * thing. Compare the axis labels in the screenshots against the UTC window this prints.
 */
import { chromium, firefox } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? '/bundle';
const engine = process.env.BROWSER === 'chromium' ? chromium : firefox;

const browser = await engine.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

await page.goto(url, { waitUntil: 'load' });
console.log('browser timezone:', await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));
console.log('browser utc offset (min):', await page.evaluate(() => new Date().getTimezoneOffset()));

await page.waitForSelector('.drop', { timeout: 30_000 });
await page.setInputFiles('input[type=file]', bundle);

await page.waitForFunction(() => document.querySelectorAll('.capture-chip').length >= 9, {
  timeout: 900_000,
});
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 20, {
  timeout: 900_000,
});
await page.waitForTimeout(4000);

const report = await page.evaluate(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const panels = [...document.querySelectorAll('.panel')];
  const withSeries = panels.filter((p) => p.querySelectorAll('.legend-item').length > 0);
  const sample = withSeries[0];
  const legend = sample?.querySelector('.legend');
  const items = [...(sample?.querySelectorAll('.legend-item') ?? [])];
  // How many legend entries actually sit above the fold, and how many columns they form.
  const box = legend?.getBoundingClientRect();
  const tops = new Set(items.map((el) => Math.round(el.getBoundingClientRect().top)));
  const lefts = new Set(items.map((el) => Math.round(el.getBoundingClientRect().left)));
  const visible = items.filter((el) => {
    const r = el.getBoundingClientRect();
    return box && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  });
  return {
    nodes: [...document.querySelectorAll('.capture-chip .capture-name')].map(text),
    warn: text(document.querySelector('.warn.pad')),
    header: text(document.querySelector('.summary')),
    timeRange: text(document.querySelector('.tr-main')),
    panelTitle: text(sample?.querySelector('.panel-title-text')),
    legendItems: items.length,
    legendRows: tops.size,
    legendColumns: lefts.size,
    legendVisibleWithoutScrolling: visible.length,
    legendScrollHeight: legend?.scrollHeight ?? 0,
    legendClientHeight: legend?.clientHeight ?? 0,
    sampleLabels: items.slice(0, 3).map(text),
  };
});

console.log('\n================ report ================');
console.log(JSON.stringify(report, null, 2));
console.log('console errors:', [...new Set(errors)].slice(0, 10));

// The whole dashboard, then one panel blown up so the x axis is readable in the PNG.
await page.screenshot({ path: 'tools/browser/nine-nodes.png' });
const panel = page.locator('.panel', { hasText: report.panelTitle }).first();
await panel.locator('button[title*="aximize"]').click();
await page.waitForTimeout(3000);
await page.screenshot({ path: 'tools/browser/nine-nodes-panel.png' });

await browser.close();
