// End-to-end check in a real browser: serves the exported site, opens it, reviews a pasted
// game with the workers and WebAssembly, and reports what the page printed.
// Usage: node web-tests/e2e.mjs [GAME_ID] [CHROMIUM_PATH]   (npm run build && smartchess export first)

import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const SITE = new URL('../site/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const gameId = process.argv[2] ?? '174318730366';
const chrome = process.argv[3] ?? 'C:/Program Files/Chromium/Application/chrome.exe';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.onnx': 'application/octet-stream', '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '');
  if (!path) path = 'index.html';
  const file = join(SITE, path);
  try {
    const st = statSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': st.size });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(0);
const base = process.env.SITE_URL ?? `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
page.on('response', r => { if (r.status() >= 400) problems.push('http ' + r.status() + ' ' + r.url()); });
page.on('requestfailed', r => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(base);
try {
  await page.waitForSelector('.game-row', { timeout: 15000 });
} catch (e) {
  console.log('home did not render. Page text:', (await page.locator('body').innerText()).slice(0, 300));
  console.log('problems:', problems);
  await browser.close();
  process.exit(1);
}
console.log('home: rows', await page.locator('.game-row').count(), '| first:', (await page.locator('.game-row').first().innerText()).replace(/\s+/g, ' ').slice(0, 90));
await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/home.png` : undefined });

// Games come straight from Chess.com and Lichess (CORS), under the page's CSP.
async function loadList(source, user) {
  await page.getByRole('button', { name: source, exact: true }).click();
  await page.fill('.user-form input', user);
  await page.locator('.user-form button').click();
  await page.waitForFunction(() => document.querySelectorAll('.game-row:not(.skeleton)').length > 1 || document.querySelector('.game-list .error'), null, { timeout: 30000 });
  const err = await page.locator('.game-list .error').count() ? await page.locator('.game-list .error').innerText() : null;
  console.log(`${source} list:`, err ?? `${await page.locator('.game-row').count()} rows`);
}
await page.getByRole('button', { name: 'All', exact: true }).click();
await loadList('Chess.com', process.env.CHESSCOM_USER ?? 'tommasobersani');
await loadList('Lichess', process.env.LICHESS_USER ?? 'penguingim1');
await page.fill('.user-form input', '');
await page.getByRole('button', { name: 'Chess.com', exact: true }).click();
await page.locator('.user-form button').click();
await page.waitForTimeout(500);

// The demo game opens from its stored review, with no analysis.
await page.locator('.game-row.demo').first().click();
await page.waitForSelector('.moment-row, .options', { timeout: 15000 });
console.log('demo review shown:', await page.locator('.moment-row').count(), 'key moments');
await page.goBack();

// A pasted PGN is analysed in the browser.
const raw = JSON.parse(readFileSync(new URL(`../data/games/${gameId}.json`, import.meta.url), 'utf-8'));
const color = raw.white.username.toLowerCase() === 'tommasobersani' ? 'white' : 'black';
await page.waitForSelector('.pgn-card summary');
await page.locator('.pgn-card summary').click();
await page.fill('textarea.pgn', raw.pgn);
await page.selectOption('.pgn-card select', color);
await page.locator('.pgn-card button[type=submit]').click();
const t0 = Date.now();
const seen = new Set();
for (let i = 0; i < 900; i++) {
  const text = (await page.locator('.coach').innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (process.env.TRACE && i % 3 === 0) console.log('   coach:', text.slice(0, 140));
  const msg = text.match(/(Downloading[^%]*%?\)?|Starting the engines|Evaluating every move: \d+\/\d+|Analysing the key moments: \d+\/\d+|Writing the explanations)/)?.[1];
  if (msg && !seen.has(msg.replace(/\d+/g, '#'))) { seen.add(msg.replace(/\d+/g, '#')); console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`); }
  if (msg?.startsWith('Evaluating') && !globalThis.shotDone && process.env.SHOT_DIR) { globalThis.shotDone = true; await page.screenshot({ path: `${process.env.SHOT_DIR}/progress.png` }); }
  if (await page.locator('.moment-row, .options, .error').count()) break;
  await page.waitForTimeout(1000);
}
console.log(`review finished after ${((Date.now() - t0) / 1000).toFixed(0)} s:`, (await page.locator('.coach').innerText()).replace(/\s+/g, ' ').slice(0, 200));
await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/review.png` : undefined });
console.log('problems:', problems.length ? problems.slice(0, 10) : 'none');
await browser.close();
server.close();
