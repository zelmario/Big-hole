/**
 * Drive the log viewer's three interactions on a real capture:
 *   1. a parsing bar while the log loads,
 *   2. double-click a chart -> the log scrolls to that moment,
 *   3. click a line -> it expands to the full text.
 * Plus the existing follow-the-window and pin behaviour.
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
await page.setInputFiles('input[type=file]', bundle);

// 1. The parsing bar should be visible while the log is read (in the DropZone during ingest).
let sawBar = false;
for (let i = 0; i < 400; i++) {
  const txt = await page.locator('.drop.working').innerText().catch(() => '');
  if (txt.includes('reading log')) { sawBar = true; break; }
  if (await page.evaluate(() => document.querySelectorAll('.panel canvas').length > 15)) break;
  await page.waitForTimeout(150);
}
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 15, undefined, { timeout: 600000, polling: 1000 });
console.log('saw parsing bar:', sawBar);
await page.waitForTimeout(2500);

// Log tab, whole-capture window.
await page.locator('.tab', { hasText: 'log' }).click();
await page.waitForFunction(() => !document.querySelector('.logview-note')?.textContent?.includes('reading'), undefined, { timeout: 30000 });
console.log('lines shown  :', await page.locator('.logline').count());

// 3. Click a slow-query line -> expands to full text (the long ones).
await page.fill('.search', 'Slow query');
await page.waitForFunction(() => !document.querySelector('.logview-note')?.textContent?.includes('reading'), undefined, { timeout: 30000 });
await page.locator('.logline').first().click();
await page.waitForTimeout(400);
const full = await page.locator('.logline.open .logline-full').first();
console.log('expanded len :', (await full.count()) ? (await full.innerText()).length : 0);
await page.fill('.search', '');
await page.waitForTimeout(1500);

// 2. Double-click a chart in its later portion (the log's coverage starts partway into the
//    capture), so there are lines at that moment to scroll to.
// The log covers roughly the middle of the capture; ~62% of the width lands inside it.
const box = await page.locator('.panel .plot').first().boundingBox();
await page.mouse.dblclick(box.x + box.width * 0.62, box.y + box.height * 0.5);
await page.waitForFunction(() => !document.querySelector('.logview-note')?.textContent?.includes('reading'), undefined, { timeout: 30000 });
await page.waitForTimeout(1200);
console.log('range now    :', (await page.locator('.tr-main').innerText()).replace(/\s+/g, ' '));
console.log('flashed line :', await page.locator('.logline.flash').count());
console.log('window lines :', await page.locator('.logline').count());

await page.screenshot({ path: 'tools/browser/logs.png' });
console.log(errors.length ? 'ERRORS:\n  ' + errors.slice(0, 5).join('\n  ') : 'no console errors');
await browser.close();
