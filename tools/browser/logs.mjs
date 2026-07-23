/**
 * Load a capture with its mongod.log and report what correlating them produced.
 *
 * Real customer data: the incident this bundle is named for is a replication lag event, so the
 * markers and the metrics should agree about when it happened.
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
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 15, { timeout: 600000 });
console.log(`ingest + parse: ${Math.round((Date.now() - started) / 1000)} s`);
await page.waitForTimeout(4000);

console.log('capture chip :', (await page.locator('.capture-chip').first().innerText()).replace(/\s+/g, ' '));

// The events tab: what the log contributed.
await page.locator('.tab', { hasText: 'events' }).click();
await page.waitForTimeout(800);
const kinds = await page.locator('.events-head select option').allInnerTexts();
console.log('event classes:', JSON.stringify(kinds));
const rows = await page.locator('.event').count();
console.log('event rows   :', rows);
console.log('first events :');
for (const t of (await page.locator('.event').allInnerTexts()).slice(0, 6)) {
  console.log('   ', t.replace(/\s+/g, ' ').slice(0, 130));
}

// Log-derived metrics must be pickable like any other metric.
await page.locator('.tab', { hasText: 'metrics' }).click();
await page.fill('.search', 'logs.');
await page.waitForTimeout(500);
const logMetrics = await page.locator('.metric-path').allInnerTexts();
console.log('log metrics  :', JSON.stringify(logMetrics.slice(0, 8)));

// Put slow-query p95 on a new panel next to the FTDC data.
await page.click('button:has-text("+ panel")');
await page.waitForTimeout(500);
await page.fill('.search', 'slowQuery.p95');
await page.waitForTimeout(500);
await page.locator('.metric').first().click();
await page.waitForTimeout(2500);
const lastPanel = page.locator('.panel').last();
console.log('new panel    :', (await lastPanel.innerText()).replace(/\s+/g, ' ').slice(0, 120));

// Click an event: every panel should zoom to that moment.
await page.locator('.tab', { hasText: 'events' }).click();
await page.waitForTimeout(400);
const fetcher = page.locator('.event', { hasText: 'Oplog fetcher' }).first();
if (await fetcher.count()) {
  await fetcher.click();
  await page.waitForTimeout(3000);
  console.log('range after  :', (await page.locator('.tr-main').first().innerText().catch(() => '?')).replace(/\s+/g, ' '));
}
// Narrowing the class must narrow the markers too, not just the list.
await page.selectOption('.events-head select', 'oplogFetcher');
await page.waitForTimeout(2000);
console.log('after filter :', (await page.locator('.events p.muted').first().innerText()).replace(/\s+/g, ' '));
await page.screenshot({ path: 'tools/browser/logs.png' });

console.log(errors.length ? 'ERRORS:\n  ' + errors.slice(0, 5).join('\n  ') : 'no console errors');
await browser.close();
