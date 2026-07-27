/**
 * Unticking a node is a view change, not a reload: the other node must keep drawing.
 *
 * Reported symptom, two nodes loaded: unticking the FIRST blanks every panel, and unticking and
 * re-ticking the SECOND brings the data back. Both states have the same visible set, so if that
 * is real it is a staleness bug rather than anything about the data -- which is precisely the
 * class jsdom cannot see, because it needs a real fetch against a real worker to be stale about.
 *
 * BUNDLE must hold exactly two node folders, each with its own diagnostic.data.
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? 'sample-data/teach2';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// A real bundle is hundreds of megabytes through the file input and then decoded; the 30 s
// default expires during the upload, long before anything under test has run.
page.setDefaultTimeout(900000);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.drop', { timeout: 15000 });
await page.setInputFiles('input[type=file]', bundle);
// Also not fatal. A bundle that never finishes ingesting is a finding, and timing out here
// prints a stack trace instead of the one thing worth knowing: how far it got.
await page
  .waitForFunction(() => document.querySelectorAll('.capture-chip').length >= 2, {
    timeout: 420000,
  })
  .catch(async () => {
    const state = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('.capture-chip')].map((c) =>
        (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
      // The ingest progress line, and any banner the app puts up when a folder fails.
      progress: (document.querySelector('.progress, .ingesting')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      // `.warn` is where App.tsx:151 puts a per-folder ingest failure. Looking anywhere else
      // reports "no error" for a bundle that in fact said exactly what went wrong.
      banner: [...document.querySelectorAll('.warn, .banner, .error')]
        .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
        .join(' | '),
      panels: document.querySelectorAll('.panel').length,
    }));
    console.log('NEVER GOT TWO CAPTURES:', JSON.stringify(state, null, 2));

    // What the failed capture left behind. An ingest that dies part-way has already written
    // most of its columns, and without a manifest nothing in the UI can reach them to drop
    // them -- so they sit there counting against the quota that caused the failure. Usage
    // should reflect the capture that succeeded, not that one plus the wreckage of this one.
    const opfs = await page.evaluate(async () => {
      const est = await navigator.storage.estimate();
      const dirs = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root = await navigator.storage.getDirectory();
      for await (const [name, handle] of root.entries()) {
        if (handle.kind === 'directory') dirs.push(name);
      }
      return { usageMB: Math.round((est.usage ?? 0) / 1e6), quotaMB: Math.round((est.quota ?? 0) / 1e6), dirs };
    });
    console.log('OPFS after the failed ingest:', JSON.stringify(opfs));
  });
// Not fatal: a dashboard that never draws is the bug under investigation, so report the state
// rather than time out and print nothing at all.
await page
  .waitForFunction(() => document.querySelectorAll('.panel canvas').length > 20, {
    timeout: 240000,
  })
  .catch(() => console.log('NOTE: never reached 20 canvases on first load'));
await page.waitForTimeout(3000);

/**
 * Wait for the dashboard to stop changing, rather than for a guessed delay.
 *
 * 46 panels x 2 nodes is a lot of reads, and a fixed wait reports whatever the repaint happened
 * to have reached -- which would make a slow redraw indistinguishable from a lost panel, the
 * exact question this script exists to answer.
 */
const stable = async (label) => {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 60; i++) {
    // Both counts: panels can settle while series are still arriving, and a series that never
    // arrives is exactly the reported symptom.
    const n = await page.evaluate(() => {
      const drawn = [...document.querySelectorAll('.panel')].filter(
        (p) => p.querySelectorAll('.legend-item').length > 0,
      ).length;
      return `${drawn}/${document.querySelectorAll('.legend-item').length}`;
    });
    same = n === last ? same + 1 : 0;
    last = n;
    if (same >= 4) return;
    await page.waitForTimeout(500);
  }
  console.log(`  (${label}: never settled, last ${last})`);
};

/** How much is actually drawn right now. */
const snap = async (what) => {
  await stable(what);
  const s = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('.panel')];
    return {
      visibleNodes: [...document.querySelectorAll('.capture-chip input[type=checkbox]')].filter(
        (b) => b.checked,
      ).length,
      panels: panels.length,
      // The real question: how many panels have a line on them.
      panelsWithSeries: panels.filter((p) => p.querySelectorAll('.legend-item').length > 0).length,
      legendItems: document.querySelectorAll('.legend-item').length,
      // "No data in this window" and friends -- a panel that resolved to nothing says so.
      emptyPanels: panels.filter((p) => p.querySelector('.empty, .error') !== null).length,
      canvases: document.querySelectorAll('.panel canvas').length,
      // Distinguishing a panel that drew nothing from one that said why is the whole question.
      messages: [
        ...new Set(
          panels
            .map((p) => p.querySelector('.pad, .error')?.textContent?.trim())
            .filter((t) => t !== undefined),
        ),
      ].slice(0, 4),
    };
  });
  console.log(what.padEnd(34), JSON.stringify(s));
  return s;
};

const both = await snap('both nodes on:');

// --- the reported break: untick the first ---
await page.locator('.capture-chip input[type=checkbox]').first().click();
await page.waitForTimeout(3500);
const firstOff = await snap('first node OFF:');

// --- the reported workaround: toggle the second off and on ---
await page.locator('.capture-chip input[type=checkbox]').nth(1).click();
await page.waitForTimeout(1500);
await page.locator('.capture-chip input[type=checkbox]').nth(1).click();
await page.waitForTimeout(3500);
const afterCycle = await snap('...then second off+on:');

// --- and the mirror case, which says whether it is about position or about order ---
await page.locator('.capture-chip input[type=checkbox]').first().click();
await page.waitForTimeout(3500);
await snap('both back on:');
await page.locator('.capture-chip input[type=checkbox]').nth(1).click();
await page.waitForTimeout(3500);
const secondOff = await snap('second node OFF:');

console.log('');
console.log('REPRODUCED:', firstOff.panelsWithSeries === 0 && afterCycle.panelsWithSeries > 0);
console.log('unticking the first blanks the dashboard:', firstOff.panelsWithSeries === 0);
console.log('unticking the second does not:', secondOff.panelsWithSeries > 0);
console.log(
  'one node should draw about half the series of two:',
  `${both.legendItems} -> ${firstOff.legendItems} (cycled: ${afterCycle.legendItems})`,
);

await page.screenshot({ path: 'tools/browser/togglenode.png' });
if (errors.length) console.log('CONSOLE ERRORS:\n  ' + errors.slice(0, 8).join('\n  '));
else console.log('no console errors');

await browser.close();
