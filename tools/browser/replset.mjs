/**
 * The member-state strip and the node info page, in a real browser.
 *
 * Neither exists in jsdom in any meaningful form: the strip's bands are percentage-positioned
 * against a measured track, the info page is a table built from a metadata document that only
 * arrives once a capture has actually been decoded through OPFS in a worker, and both are only
 * interesting on a bundle where the members disagree with each other. So this drives the
 * shipped app end to end over a real three-member capture with real elections in it, and reports
 * what it found rather than asserting against a mock.
 *
 * BUNDLE must be a directory with one folder per node, each holding its own diagnostic.data.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? 'sample-data/teach3';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
// The privacy promise, enforced at runtime rather than trusted.
await page.route('**/*', (route) => {
  const target = route.request().url();
  if (target.startsWith(url)) return route.continue();
  errors.push(`NETWORK REQUEST: ${target}`);
  return route.abort();
});

await page.waitForSelector('.drop', { timeout: 15000 });
await page.setInputFiles('input[type=file]', bundle);
await page.waitForSelector('.capture-chip', { timeout: 180000 });
await page.waitForFunction(() => document.querySelectorAll('.capture-chip').length >= 3, {
  timeout: 180000,
});
// The strip is built after the dashboard paints, deliberately -- so wait for it, do not guess.
await page.waitForSelector('.states-run', { timeout: 120000 });
await page.waitForTimeout(1500);

const strip = await page.evaluate(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('.states-row')].filter(
    (r) => !r.classList.contains('states-axis'),
  );
  return {
    rows: rows.map((r) => ({
      name: text(r.querySelector('.states-name')),
      peer: r.querySelector('.states-name')?.classList.contains('peer') ?? false,
      // The bands, as the reader sees them: what state, and how wide.
      runs: [...r.querySelectorAll('.states-run')].map((b) => ({
        state: text(b),
        widthPct: Number(b.style.width.replace('%', '')).toFixed(1),
        leftPct: Number(b.style.left.replace('%', '')).toFixed(1),
      })),
    })),
    // A band that does not tile its track is a rendering bug that looks like missing data.
    coverage: rows.map((r) =>
      [...r.querySelectorAll('.states-run')]
        .reduce((n, b) => n + Number(b.style.width.replace('%', '')), 0)
        .toFixed(1),
    ),
    axisTicks: [...document.querySelectorAll('.states-tick')].map(text),
    trackWidth: document.querySelector('.states-track')?.getBoundingClientRect().width ?? 0,
  };
});

console.log('--- member state strip ---');
console.log(JSON.stringify(strip, null, 2));
await page.screenshot({ path: 'tools/browser/replset-strip.png', clip: { x: 0, y: 0, width: 1600, height: 340 } });

// Clicking a band zooms every chart to it. That is the gesture the strip exists to offer, and
// it crosses from this component into the shared range, so it is worth proving rather than
// assuming.
const before = await page.evaluate(() => document.querySelector('.summary')?.textContent ?? '');
await page.locator('.states-run').nth(1).click();
await page.waitForTimeout(1200);
const zoomed = await page.evaluate(() => ({
  range: [...document.querySelectorAll('.states-tick')].map((e) => e.textContent),
  reset: document.body.textContent.includes('reset zoom'),
}));
console.log('--- click-to-zoom ---');
console.log(JSON.stringify({ before: before.slice(0, 60), zoomed }, null, 2));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'reset zoom');
  b?.click();
});
await page.waitForTimeout(800);

// --- the info page ---
await page.evaluate(() => {
  const b = [...document.querySelectorAll('header button')].find((x) => x.textContent === 'info');
  b?.click();
});
await page.waitForSelector('.info-table', { timeout: 20000 });
await page.waitForTimeout(500);

const info = await page.evaluate(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('.info-table tbody tr')];
  return {
    columns: [...document.querySelectorAll('.info-table thead th')].map(text),
    sections: rows.filter((r) => r.classList.contains('info-section')).map(text),
    fieldCount: rows.filter((r) => !r.classList.contains('info-section')).length,
    differing: rows
      .filter((r) => r.classList.contains('info-differs'))
      .map((r) => [...r.children].map(text)),
    sample: rows
      .filter((r) => !r.classList.contains('info-section'))
      .slice(0, 14)
      .map((r) => [...r.children].map(text)),
    warnings: [...document.querySelectorAll('.info-body .warn')].map(text),
  };
});

console.log('--- node info ---');
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: 'tools/browser/replset-info.png', fullPage: false });

console.log('--- console errors ---');
console.log(errors.length === 0 ? 'none' : JSON.stringify(errors, null, 2));

await browser.close();
process.exit(errors.length === 0 ? 0 : 1);
