/**
 * README screenshots, taken from the real app rather than mocked up.
 *
 * The README carries three: the dashboard, the log viewer and the node info page. The rest are
 * still taken, because
 * they cost nothing on a run that has already ingested the capture and they are what you look at
 * when a UI change needs reviewing -- they are simply not referenced by the README.
 *
 * A screenshot in a README is a claim about what the tool does, so these are driven through the
 * shipped app in a real browser with a real capture, the same way the verify scripts are. If a
 * feature stops drawing, the picture of it stops being takeable.
 *
 * The capture is whatever BUNDLE points at, and that choice matters: FTDC metadata carries the
 * hostname, so a screenshot of someone else's bundle publishes their infrastructure names. Point
 * this at data you are content to make public.
 *
 *   BUNDLE=sample-data/teach3 node tools/browser/shots.mjs
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? 'sample-data/teach3';
const out = process.env.OUT ?? 'docs/img';

await mkdir(out, { recursive: true });

const browser = await chromium.launch();
// A README image is read at half its width on GitHub, so shoot at 2x-ish and let it scale.
const page = await browser.newPage({ viewport: { width: 1680, height: 1020 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.drop', { timeout: 15000 });
await page.setInputFiles('input[type=file]', bundle);
await page.waitForSelector('.capture-chip', { timeout: 300000 });
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 10, {
  timeout: 300000,
});
await page.waitForTimeout(4000);

const labels = await page.locator('.capture-chip').allInnerTexts();
console.log('captures:', JSON.stringify(labels.map((l) => l.replace(/\s+/g, ' ').trim())));

const shot = async (name, locator) => {
  const target = locator ?? page;
  await target.screenshot({ path: `${out}/${name}.png` });
  console.log(`  ${out}/${name}.png`);
};

// --- the dashboard, which is the hero image ---
await shot('dashboard');

// --- the catalogue: search for something specific so it is not just a scrolled list ---
await page.locator('.sidebar-tabs .tab', { hasText: 'metrics' }).click();
const search = page.locator('.sidebar input[type=search], .sidebar .search').first();
if (await search.count()) {
  await search.fill('cache dirty');
  await page.waitForTimeout(800);
}
await shot('catalogue', page.locator('.sidebar'));

// --- one panel drawing every node, which is the whole point of the multi-capture support ---
const fanned = page.locator('.panel').filter({ has: page.locator('.legend-host') }).first();
if (await fanned.count()) {
  await fanned.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await shot('multi-node', fanned);
}

// --- the checks ---
await page.locator('.sidebar-tabs .tab', { hasText: 'checks' }).click();
await page.waitForTimeout(3000);
await shot('checks', page.locator('.sidebar'));

// --- explain, reached the way a reader reaches it: from the worst finding ---
// Falling back to a brush keeps the shot takeable on a capture where nothing fired, but a
// finding's own "explain" link lands on a window that actually contains something.
const explainLink = page.locator('.finding button', { hasText: 'explain' }).first();
if (await explainLink.count()) {
  await explainLink.click();
} else {
  const plot = page.locator('.panel .u-over').first();
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await page.locator('.sidebar-tabs .tab', { hasText: 'explain' }).click();
}
await page
  .waitForFunction(() => document.querySelectorAll('.change').length > 0, { timeout: 120000 })
  .catch(() => {});
await page.waitForTimeout(1500);
await shot('explain', page.locator('.sidebar'));

// --- the log, so it is showing the incident window rather than the whole capture ---
await page.locator('.sidebar-tabs .tab', { hasText: 'log' }).click();
await page.waitForTimeout(3000);
await shot('log', page.locator('.sidebar'));

// --- the info page last: it is an overlay, so anything shot after it would be behind a scrim ---
await page.locator('header button', { hasText: 'info' }).click();
await page.waitForSelector('.info-table', { timeout: 30000 });
await page.waitForTimeout(800);
await shot('node-info', page.locator('.infopage'));

console.log(errors.length === 0 ? 'no page errors' : `PAGE ERRORS:\n${errors.join('\n')}`);
await browser.close();
