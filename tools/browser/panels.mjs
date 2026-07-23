/**
 * Load a capture and report what every panel actually drew.
 *
 * The dashboard degrades silently by design -- a panel that cannot resolve is dropped, and a
 * series that resolves to nothing is simply absent -- so "it looks fine" is not evidence.
 * This enumerates every panel with its series count and any message it is showing.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? 'sample-data/multi';
const shot = process.env.SHOT ?? 'tools/browser/panels';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.drop', { timeout: 15000 });
await page.setInputFiles('input[type=file]', bundle);
try {
  await page.waitForSelector('.capture-chip', { timeout: Number(process.env.WAIT ?? 300000) });
} catch (err) {
  // Say what the app is actually showing rather than just "timed out".
  console.log('STUCK. visible text:', (await page.locator('body').innerText()).slice(0, 600));
  throw err;
}
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 15, { timeout: 300000 });
await page.waitForTimeout(4000);

const report = await page.evaluate(() => {
  const clean = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const sections = [...document.querySelectorAll('.section h2')].map(clean);
  const panels = [...document.querySelectorAll('.panel')].map((p) => ({
    title: clean(p.querySelector('.panel-title-text')),
    series: p.querySelectorAll('.legend-item').length,
    chart: p.querySelectorAll('canvas').length > 0,
    message: clean(p.querySelector('.pad')) || clean(p.querySelector('.error')) || '',
    units: [...new Set([...p.querySelectorAll('.legend-value')].map((v) =>
      clean(v).replace(/^[-\d.,]+\s*/, '') || 'bare'))],
  }));
  return { sections, panels, captures: [...document.querySelectorAll('.capture-chip b')].map(clean) };
});

console.log('captures:', report.captures.join(' | '));
console.log('sections:', report.sections.join(' | '));
console.log(`panels drawn: ${report.panels.length}`);
for (const p of report.panels) {
  const flag = !p.chart ? 'NO CHART' : p.series === 0 ? 'NO SERIES' : '';
  console.log(
    `  ${(p.title || '(untitled)').padEnd(48)} ${String(p.series).padStart(2)} series  ` +
      `${p.units.join(',').padEnd(14)} ${flag}${p.message ? ' :: ' + p.message : ''}`,
  );
}
console.log(errors.length ? `CONSOLE ERRORS: ${errors.slice(0, 5).join(' | ')}` : 'no console errors');

// Screenshot the whole dashboard in viewport-sized slices.
const height = await page.evaluate(() => document.querySelector('.charts').scrollHeight);
for (let i = 0; i < Math.min(4, Math.ceil(height / 900)); i++) {
  await page.evaluate((y) => { document.querySelector('.charts').scrollTop = y; }, i * 850);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shot}-${i}.png` });
}
await browser.close();
