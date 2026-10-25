// Checks the anonymous counters in a real browser: what the page sends, that it sends nothing
// with Do Not Track or ?from=me, and that no username, game or text can leave in a counter.
// Usage: node web-tests/stats.mjs [CHROMIUM_PATH]   (pnpm run build && smartchess export --stats-url <any URL> first)

import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const SITE = new URL('../site/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const chrome = process.argv[2] ?? 'C:/Program Files/Chromium/Application/chrome.exe';
const statsUrl = readFileSync(join(SITE, 'index.html'), 'utf-8').match(/name="smartchess-stats" content="([^"]+)"/)?.[1];
if (!statsUrl) {
  console.log('stats: the exported site has no counters URL (export with --stats-url): skipped');
  process.exit(0);
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const file = join(SITE, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '') || 'index.html');
  try {
    const st = statSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': st.size });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end('not found'); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: chrome, headless: true });

async function visit(url, { dnt = false, steps } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'it-IT' });
  if (dnt) await context.addInitScript(() => Object.defineProperty(navigator, 'doNotTrack', { value: '1' }));
  const sent = [];
  await context.route(statsUrl + '**', route => {
    const req = route.request();
    sent.push({ method: req.method(), type: req.headers()['content-type'], body: req.postData() });
    route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  await page.goto(url);
  await page.waitForSelector('.game-row', { timeout: 15000 });
  if (steps) await steps(page);
  await page.evaluate(() => dispatchEvent(new Event('pagehide'))); // the visit ends: the duration is sent
  await page.waitForTimeout(500);
  await context.close();
  assert.deepEqual(problems, []);
  return sent.flatMap(s => { assert.equal(s.method, 'POST'); assert.equal(s.type, 'text/plain'); return JSON.parse(s.body).k; });
}

const keys = await visit(base + '?from=chess', {
  steps: async page => {
    await page.locator('.game-row.demo').first().click();
    await page.waitForSelector('.moment-row', { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/about'; });
    await page.waitForSelector('.about');
  },
});
console.log('sent:', keys.join(' '));
for (const k of ['view', 'view.ref.direct', 'view.dev.desktop', 'view.lang.it', 'view.from.chess', 'open.demo', 'about']) assert.ok(keys.includes(k), `missing ${k}`);
assert.ok(keys.some(k => k.startsWith('leave.dur.')), 'missing the duration');
for (const k of keys) assert.match(k, /^[a-z_]+(\.[a-z0-9_]+){0,3}$/, `not a counter name: ${k}`);

assert.deepEqual(await visit(base, { dnt: true }), [], 'Do Not Track must send nothing');
assert.deepEqual(await visit(base + '?from=me'), [], '?from=me must send nothing');
console.log('stats: ok (counters sent, nothing with Do Not Track or ?from=me)');
await browser.close();
server.close();
