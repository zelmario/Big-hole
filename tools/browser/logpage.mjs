/**
 * Does the log window page, or does it stop at the cap?
 *
 * The buffer is a sliding window: reaching either edge loads the next page and drops the same
 * number of lines off the far end. Every part of that is invisible to jsdom -- the reads happen
 * in a worker against a real File, and the thing being tested is what a scroll event does to a
 * scroll container. So this drives the shipped app against a real 73 MB / 150k-line log.
 *
 * What it asserts, in order: the buffer fills; scrolling to the bottom advances it to lines that
 * were not there before; the reader's place is held across the load rather than jumping; and
 * scrolling back up returns to earlier lines. BUNDLE must hold one node with a diagnostic.data
 * and a log beside it.
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
await page.waitForSelector('.drop', { timeout: 15000 });
await page.setInputFiles('input[type=file]', bundle);
await page.waitForSelector('.capture-chip', { timeout: 300000 });
await page.waitForFunction(() => document.querySelectorAll('.panel canvas').length > 5, {
  timeout: 300000,
});

// The log is parsed in the same streaming pass that persists it; wait for that to finish rather
// than guess, then open the full-screen window where the 10,000-line buffer lives.
await page
  .waitForFunction(() => document.querySelector('.logview-parsing') === null, { timeout: 600000 })
  .catch(() => errors.push('log still parsing after 10 minutes'));

const logTab = page.locator('.sidebar-tabs button', { hasText: /log/i }).first();
if (await logTab.count()) await logTab.click();
await page.waitForSelector('.logview', { timeout: 60000 });
await page.locator('button', { hasText: 'full screen' }).first().click();
await page.waitForSelector('.logwindow .logview-lines', { timeout: 60000 });

const listSel = '.logwindow .logview-lines';
// Both spellings the note uses while a read is outstanding: 'reading…' for the window fetch,
// 'loading ↑/↓' for a page. Waiting on the wrong one silently measures nothing.
const settle = async () => {
  await page.waitForFunction(
    () => {
      const note = document.querySelector('.logwindow .logview-note')?.textContent ?? '';
      return !note.includes('reading') && !note.includes('loading');
    },
    { timeout: 180000 },
  );
  await page.waitForTimeout(400);
};

// The first window over a 73 MB log is a full scan; wait for lines, not for a guessed delay.
await page.waitForFunction(
  () => document.querySelectorAll('.logwindow .logline').length > 0,
  { timeout: 300000 },
);

/** What the buffer currently holds: count, first/last timestamp, note text. */
const snap = async () =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const rows = [...el.querySelectorAll('.logline')];
    const at = (r) => r?.querySelector('.logline-time')?.textContent ?? '';
    return {
      count: rows.length,
      first: at(rows[0]),
      last: at(rows[rows.length - 1]),
      // Scoped: the sidebar renders its own LogView with its own note and its own smaller
      // buffer, and an unscoped selector reports that one while measuring this one's rows.
      note: (document.querySelector('.logwindow .logview-note')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
    };
  }, listSel);

await settle();
const initial = await snap();
console.log('initial:      ', JSON.stringify(initial));

// --- scroll to the bottom repeatedly: the window must advance through the log ---
const seen = [initial.last];
for (let i = 0; i < 4; i++) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollTop = el.scrollHeight;
  }, listSel);
  await settle();
  const s = await snap();
  console.log(`after end #${i + 1}:`, JSON.stringify(s));
  seen.push(s.last);
}

const advanced = seen[seen.length - 1] > seen[0];
console.log('advanced through the log:', advanced, `${seen[0]} -> ${seen[seen.length - 1]}`);

// --- the reader's place must survive a page load, not jump to an edge ---
const bottom = await snap();
const heldPlace =
  bottom.scrollTop > 0 && bottom.scrollTop < bottom.scrollHeight - bottom.clientHeight;
console.log('place held after paging down (not pinned to an edge):', heldPlace);

// --- and back up: earlier lines must come back ---
// Until the buffer says there is nothing above it, not a fixed number of pages: how many pages
// it takes to walk back is a function of the log's density, and a fixed count would report a
// short walk as a lost line.
const atBottom = await snap();
for (let i = 0; i < 20; i++) {
  const more = await page.evaluate(
    () => (document.querySelector('.logwindow .logview-note')?.textContent ?? '').includes('↑'),
  );
  if (!more) break;
  await page.evaluate((sel) => {
    document.querySelector(sel).scrollTop = 0;
  }, listSel);
  await settle();
}
const backUp = await snap();
console.log('after scrolling back up:', JSON.stringify(backUp));
console.log('went back in time:', backUp.first < atBottom.first);
// Scrolling to the top must reach the window's real first line. Anything later means the page
// overlap ate lines -- which is what a key-based dedupe does to a log that repeats a line
// verbatim inside one millisecond.
console.log(
  'reached the true first line:',
  backUp.first === initial.first,
  `${backUp.first} vs ${initial.first}`,
);

// Memory is the reason the buffer is capped at all; a page that grew it without evicting would
// still pass everything above.
console.log(
  'buffer stayed capped:',
  backUp.count <= 10000 && bottom.count <= 10000,
  `(max seen ${Math.max(initial.count, bottom.count, backUp.count)})`,
);

await page.screenshot({ path: 'tools/browser/logpage.png' });
if (errors.length) console.log('CONSOLE ERRORS:\n  ' + errors.slice(0, 8).join('\n  '));
else console.log('no console errors');

await browser.close();
