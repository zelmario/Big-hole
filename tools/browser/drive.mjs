import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5173/debug-grid.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.react-grid-item', { timeout: 10000 });

const before = await page.evaluate(() => window.geometry());
console.log('before      :', before);

// --- drag panel A's header 300px right ---
const head = page.locator('.react-grid-item .drag-handle').first();
const box = await head.boundingBox();
console.log('handle box  :', JSON.stringify(box));
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 10 });
await page.mouse.move(box.x + box.width / 2 + 320, box.y + box.height / 2, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log('after drag  :', await page.evaluate(() => window.geometry()));

// --- resize panel A from its bottom-right handle ---
const rh = page.locator('.react-grid-item > .react-resizable-handle').first();
const rbox = await rh.boundingBox();
console.log('resize box  :', JSON.stringify(rbox));
if (rbox) {
  await page.mouse.move(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rbox.x + 200, rbox.y + 120, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
console.log('after resize:', await page.evaluate(() => window.geometry()));
if (errors.length) console.log('CONSOLE ERRORS:\n  ' + errors.slice(0, 5).join('\n  '));
await browser.close();
