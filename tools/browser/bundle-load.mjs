/**
 * Load a whole support bundle -- every node in it -- into the real app, and report what failed.
 *
 * Written for a nine-node bundle that loaded eight nodes and reported two folders as
 * "JSON.parse: unexpected end of data". Nothing smaller reproduces it: the failure
 * is about what nine concurrently-decoded captures do to the origin's storage quota, so it
 * needs the real browser, the real worker pool and the real OPFS.
 *
 * BROWSER=firefox|chromium -- the report came from Firefox, and quota policy is the one thing
 * the two engines most disagree about, so which one this runs in is part of the test.
 *
 *   BUNDLE=/bundle node tools/browser/bundle-load.mjs
 */
import { chromium, firefox } from 'playwright';

const url = process.env.URL ?? 'http://127.0.0.1:5174/';
const bundle = process.env.BUNDLE ?? 'sample-data/multi';
const engine = process.env.BROWSER === 'chromium' ? chromium : firefox;
const budgetMs = Number(process.env.BUDGET_MS ?? 1_800_000);

// PROFILE puts the browser profile on a filesystem of a chosen size. Firefox sizes an origin's
// storage quota from the filesystem its profile lives on, so pointing this at a small tmpfs is
// how "the browser ran out of room" becomes reachable in a test instead of only on a laptop
// with a real bundle on it.
const profile = process.env.PROFILE;
const browser = profile
  ? await engine.launchPersistentContext(profile, { viewport: { width: 1600, height: 1000 } })
  : await engine.launch();
const page = profile
  ? await browser.newPage()
  : await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('.drop', { timeout: 30_000 });

const before = await page.evaluate(() => navigator.storage.estimate());
console.log('quota before:', JSON.stringify(before));

await page.setInputFiles('input[type=file]', bundle);
console.log('files handed to the app, decoding…');

// Poll rather than wait on one selector: the interesting outcome is a partial success, where
// the dashboard comes up and some nodes are simply missing.
const started = Date.now();
let last = '';
while (Date.now() - started < budgetMs) {
  const state = await page.evaluate(() => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      ingesting: document.querySelector('.drop.working') !== null,
      nodes: [...document.querySelectorAll('.node-progress b')].map(text),
      chips: [...document.querySelectorAll('.capture-chip .capture-name')].map(text),
      // Every warning slot: the dashboard's (partial success) and the drop zone's (total
      // failure, where the app never leaves the picker).
      warn: [...document.querySelectorAll('.warn, .error')].map(text).filter(Boolean),
    };
  });
  const line = `${Math.round((Date.now() - started) / 1000)}s  decoding=${state.ingesting} nodes=${state.nodes.length} chips=${state.chips.length}`;
  if (line.slice(line.indexOf(' ')) !== last) {
    console.log(line);
    last = line.slice(line.indexOf(' '));
  }
  if (!state.ingesting && state.chips.length > 0) break;
  await page.waitForTimeout(5000);
}

await page.waitForTimeout(3000);
const report = await page.evaluate(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    chips: [...document.querySelectorAll('.capture-chip .capture-name')].map(text),
    warn: text(document.querySelector('.warn.pad')),
    panels: document.querySelectorAll('.panel').length,
  };
});
const after = await page.evaluate(() => navigator.storage.estimate());

console.log('\n================ report ================');
console.log('nodes loaded :', report.chips.length);
for (const c of report.chips) console.log('   ', c);
console.log('warning      :', report.warn || '(none)');
console.log('quota after  :', JSON.stringify(after));
console.log('console errs :');
for (const e of [...new Set(errors)].slice(0, 30)) console.log('   ', e);

await page.screenshot({ path: 'tools/browser/bundle-load.png', fullPage: false });
await browser.close();
