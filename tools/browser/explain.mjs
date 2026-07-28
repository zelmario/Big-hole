/**
 * Brush a window and explain it, in a real browser.
 *
 * The gesture is the feature: drag across a chart, open the explain tab, and the ranking is
 * already there for the window you are looking at. None of that is testable in jsdom -- the
 * scan runs in a worker over OPFS, the brush is a uPlot pointer drag, and the auto-run is an
 * effect that fires on a range the drag produced. So this drives the shipped app.
 *
 * It reports rather than asserts, except on the things that would make the feature a lie: a
 * console error, a network request, or an empty ranking on a window that visibly moved.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? 'sample-data/logpage';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.route('**/*', (route) => {
  const target = route.request().url();
  if (target.startsWith(url)) return route.continue();
  errors.push(`NETWORK REQUEST: ${target}`);
  return route.abort();
});

await page.waitForSelector('.drop', { timeout: 15000 });
await page.setInputFiles('input[type=file]', bundle);
await page.waitForSelector('.capture-chip', { timeout: 300000 });
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 5, {
  timeout: 300000,
});
await page.waitForTimeout(2000);

// --- the gesture: drag across the middle third of the first chart ---
const plot = page.locator('.panel .u-over').first();
const box = await plot.boundingBox();
await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1500);

await page.locator('.sidebar-tabs .tab', { hasText: 'explain' }).click();
// The tab runs on mount for the window already on screen; the wait is for the ranking, not for
// a button press.
await page
  .waitForFunction(() => document.querySelectorAll('.change').length > 0, { timeout: 120000 })
  .catch(() => {});
await page.waitForTimeout(1000);

const report = await page.evaluate(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    header: text(document.querySelector('.insights .logview-note')),
    baseline: text(document.querySelector('.insights .muted.small.pad')),
    events: [...document.querySelectorAll('.change-event')].map(text).slice(0, 5),
    changes: [...document.querySelectorAll('.change:not(.change-event)')].map(text).slice(0, 12),
    changeCount: document.querySelectorAll('.change:not(.change-event)').length,
  };
});
console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: 'tools/browser/explain.png' });

// --- clicking a row puts the metric on the focused panel, which is the whole point of a row ---
const before = await page.locator('.panel .legend-item').count();
await page.locator('.change:not(.change-event)').first().click();
await page.waitForTimeout(2500);
const after = await page.locator('.panel .legend-item').count();
console.log(`legend entries: ${before} -> ${after} (clicking a change adds it to a panel)`);

// --- and the width guard: zooming out to the whole capture must say so, not freeze ---
await page.locator('.tr-main').click();
await page.locator('.tr-preset', { hasText: 'Whole capture' }).click();
await page.waitForTimeout(3000);
const wide = await page.evaluate(() => {
  const el = document.querySelector('.sidebar .logview.empty, .sidebar .insights');
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
});
console.log('whole-capture window:', wide);

console.log(errors.length === 0 ? '\nno console errors, no network requests' : `\nERRORS:\n${errors.join('\n')}`);
await browser.close();
if (report.changeCount === 0) {
  console.error('\nFAIL: the ranking was empty for a brushed window');
  process.exit(1);
}
process.exit(errors.length === 0 ? 0 : 1);
