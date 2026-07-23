/**
 * Load a two-node bundle into the real app, in a real browser.
 *
 * Everything M4 adds is invisible to jsdom: OPFS lives in a worker, the worker pool is real
 * Workers, and the whole point -- one panel becoming one line per node -- only exists once
 * two captures have actually been decoded. So this drives the shipped app end to end and
 * reports what it finds rather than asserting on a mock.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? 'sample-data/multi';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

// The privacy promise, enforced at runtime rather than trusted: nothing may reach the network
// once the app has loaded.
await page.goto(url, { waitUntil: 'networkidle' });
await page.route('**/*', (route) => {
  const target = route.request().url();
  if (target.startsWith(url)) return route.continue();
  errors.push(`NETWORK REQUEST: ${target}`);
  return route.abort();
});

await page.waitForSelector('.drop', { timeout: 15000 });
await page.setInputFiles('input[type=file]', bundle);

await page.waitForSelector('.capture-chip', { timeout: 180000 });
await page.waitForFunction(() => document.querySelectorAll('.capture-chip').length >= 2, {
  timeout: 180000,
});
// 42 panels x 2 nodes is a lot of first reads; wait for the charts, do not guess a delay.
await page.waitForFunction(
  () => document.querySelectorAll('.panel canvas').length > 20,
  { timeout: 180000 },
);
await page.waitForTimeout(2000);

const report = await page.evaluate(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const panels = [...document.querySelectorAll('.panel')];
  const withSeries = panels.filter((p) => p.querySelectorAll('.legend-item').length > 0);
  const fannedOut = panels.filter((p) => p.querySelectorAll('.legend-host').length >= 2);
  const crossHost = panels.filter((p) => text(p).includes('lag') || text(p).includes('skew'));
  return {
    captures: [...document.querySelectorAll('.capture-chip')].map(text),
    panels: panels.length,
    panelsWithSeries: withSeries.length,
    panelsShowingBothNodes: fannedOut.length,
    canvases: document.querySelectorAll('.panel canvas').length,
    crossHostPanels: crossHost.map((p) => text(p.querySelector('.panel-title-text'))),
    sampleLegend: [...(withSeries[0]?.querySelectorAll('.legend-item') ?? [])]
      .slice(0, 4)
      .map(text),
    emptyMessages: [...document.querySelectorAll('.panel .error')].map(text).slice(0, 5),
  };
});

console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: 'tools/browser/multi.png' });

// Untick a node: the panels must redraw with one line each, without a reload.
await page.click('.capture-chip input[type=checkbox]');
await page.waitForTimeout(2500);
const afterHide = await page.evaluate(() => ({
  panelsShowingBothNodes: [...document.querySelectorAll('.panel')].filter(
    (p) => p.querySelectorAll('.legend-host').length >= 2,
  ).length,
  legendItems: document.querySelectorAll('.legend-item').length,
}));
console.log('after hiding one node:', JSON.stringify(afterHide));

await page.screenshot({ path: 'tools/browser/multi-one-node.png' });
if (errors.length) console.log('CONSOLE ERRORS:\n  ' + errors.slice(0, 8).join('\n  '));
else console.log('no console errors');

await browser.close();
