/**
 * Check the container image actually runs the app, rather than merely serving its files.
 *
 * `curl` proves nginx returns 200s. It does not prove the app mounts, that Web Workers start, or
 * that OPFS is available -- and OPFS is the one that fails quietly: browsers grant it only in a
 * secure context, so an image reached over a plain `http://some-host` address serves perfectly
 * and then cannot store a capture. That surfaces during ingest and reads like a decoder bug.
 *
 * Run with the browser sharing the app container's network namespace, so `localhost` inside this
 * process is the container's nginx and the secure-context rule is exercised honestly:
 *
 *   docker run --rm --network container:<name> -v "$PWD":/app -w /app \
 *     mcr.microsoft.com/playwright:v<ver>-noble node tools/browser/verify-docker.mjs
 */
import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost/';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(url, { waitUntil: 'networkidle' });

// Nothing may leave the origin the app was served from.
await page.route('**/*', (route) => {
  const target = route.request().url();
  if (target.startsWith(url) || target.startsWith('http://localhost')) return route.continue();
  errors.push(`NETWORK REQUEST: ${target}`);
  return route.abort();
});

await page.waitForSelector('.drop', { timeout: 30000 });

const report = await page.evaluate(async () => {
  const out = { secure: isSecureContext, worker: false, opfs: false, bytes: 0 };
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('probe.bin', { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await w.close();
    out.bytes = (await fh.getFile()).size;
    out.opfs = out.bytes === 8;
    await root.removeEntry('probe.bin');
  } catch (e) {
    out.opfsError = String(e);
  }
  try {
    const blob = new Blob(['self.postMessage("up")'], { type: 'text/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    out.worker = (await new Promise((r) => { worker.onmessage = (e) => r(e.data); })) === 'up';
  } catch (e) {
    out.workerError = String(e);
  }
  return out;
});

console.log(JSON.stringify({ ...report, title: await page.title(), errors }, null, 2));
await browser.close();

const ok = report.secure && report.opfs && report.worker && errors.length === 0;
console.log(ok ? '\nthe image runs the app: secure context, OPFS, workers, no network' : '\nFAILED');
process.exit(ok ? 0 : 1);
