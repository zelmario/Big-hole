/**
 * Does the app come back after a reload, with a used localStorage?
 *
 * A fresh browser profile is the easy case and the one every other check runs. This ingests a
 * capture, saves a dashboard, then reloads -- so the app boots with a persisted layout, a
 * current-dashboard id and a permalink in the address bar, which is the state a real user's
 * tab is in every morning.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e)));

const state = async (tag) => {
  const s = await page.evaluate(() => ({
    body: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
    panels: document.querySelectorAll('.panel').length,
    localStorageKeys: Object.keys(localStorage),
  }));
  console.log(tag, JSON.stringify(s));
  return s;
};

await page.goto(process.env.URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.drop');
await page.setInputFiles('input[type=file]', 'sample-data/multi');
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 15, { timeout: 180000 });
await state('after ingest  ');

// Save a dashboard, so the reload has a current-dashboard id to restore too.
await page.locator('.dash-current').click();
await page.waitForTimeout(300);
const save = page.locator('button', { hasText: /^save$/i }).first();
if (await save.count()) { await save.click(); await page.waitForTimeout(500); }
await page.keyboard.press('Escape');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const after = await state('after reload  ');
if (after.panels === 0 && !after.body) console.log('BLANK PAGE after reload');

// The captures were decoded before the reload, so they must be offered back without another
// ingest -- that is the whole point of writing them to OPFS.
await page.waitForSelector('.recent', { timeout: 20000 });
console.log('recent rows :', await page.locator('.recent li').count());
const started = Date.now();
await page.locator('.recent-head button').click(); // open all
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 15, { timeout: 120000 });
console.log(`reopen took : ${Date.now() - started} ms (no decode)`);
await state('after reopen  ');

console.log(errors.length ? 'ERRORS:\n  ' + errors.slice(0, 6).join('\n  ') : 'no console errors');
await browser.close();
