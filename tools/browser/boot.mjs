/**
 * A failure to boot must be visible on the page.
 *
 * Simulates the one case no in-app handler can catch: a module that fails while the graph is
 * being imported, so main.tsx never evaluates and nothing it registers exists. The page must
 * still say what happened.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const browser = await chromium.launch();

async function check(label, breakModule) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  if (breakModule !== null) {
    await page.route(`**${breakModule}*`, (route) => route.abort());
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The watchdog fires at 5 s; give it a moment past that.
  await page.waitForTimeout(breakModule === null ? 3000 : 7000);
  const seen = await page.evaluate(() => ({
    text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    children: document.getElementById('root')?.childElementCount ?? 0,
  }));
  console.log(`${label}: ${JSON.stringify(seen)}`);
  await page.close();
  return seen;
}

const healthy = await check('healthy boot ', null);
const broken = await check('broken import', '/src/App.tsx');

const ok =
  healthy.children > 0 &&
  !healthy.text.includes('did not start') &&
  broken.children > 0 &&
  broken.text.includes('did not start');
console.log(ok ? 'PASS: a broken import reports itself' : 'FAIL: blank page survived');
await browser.close();
process.exit(ok ? 0 : 1);
