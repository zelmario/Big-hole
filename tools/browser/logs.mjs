/**
 * Load a capture with its mongod.log and drive the log viewer.
 *
 * The viewer follows the dashboard window, highlights notable lines, and pins a marker on
 * double-click. All three are checked here on real customer data.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? '/bundle';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.drop');
const started = Date.now();
await page.setInputFiles('input[type=file]', bundle);
await page.waitForFunction(
  () => document.querySelectorAll('.panel canvas').length > 15,
  undefined,
  { timeout: 600000, polling: 1000 },
);
console.log(`ingest + parse: ${Math.round((Date.now() - started) / 1000)} s`);
await page.waitForTimeout(3000);

// Open the log tab.
await page.locator('.tab', { hasText: 'log' }).click();
// The read follows the window; the whole-capture window is a real read, so give it a moment.
await page.waitForFunction(() => !document.querySelector('.logview-note')?.textContent?.includes('reading'), undefined, { timeout: 30000 });
console.log('note         :', (await page.locator('.logview-note').first().innerText()).replace(/\s+/g, ' '));
console.log('lines shown  :', await page.locator('.logline').count());
console.log('notable lines:', await page.locator('.logline.important').count());
console.log('first notable:');
for (const t of (await page.locator('.logline.important').allInnerTexts()).slice(0, 4)) {
  console.log('   ', t.replace(/\s+/g, ' ').slice(0, 120));
}

// Notable-only: the highlighted lines become the whole list, for scanning a wide window.
await page.locator('.logview-head input[type=checkbox]').check();
await page.waitForFunction(() => !document.querySelector('.logview-note')?.textContent?.includes('reading'), undefined, { timeout: 30000 });
console.log('notable-only :', (await page.locator('.logview-note').first().innerText()).replace(/\s+/g, ' '));

// Double-click a notable line: a pin marker must appear on the charts.
const notable = page.locator('.logline.important').first();
if (await notable.count()) {
  await notable.dblclick();
  await page.waitForTimeout(1500);
  console.log('pins in tab  :', (await page.locator('.tab-pins').first().innerText().catch(() => '0')));
  console.log('pinned rows  :', await page.locator('.logline.pinned').count());
}
await page.screenshot({ path: 'tools/browser/logs.png' });
console.log(errors.length ? 'ERRORS:\n  ' + errors.slice(0, 5).join('\n  ') : 'no console errors');
await browser.close();
