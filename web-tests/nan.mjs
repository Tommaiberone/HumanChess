// Reproduce: review a pasted PGN on a desktop window and report when the console prints NaN arrow errors.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROMIUM, serve } from './serve.mjs';

const site = await serve();
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let t0 = Date.now();
page.on('console', async m => {
  if (m.type() !== 'error' || !/NaN/.test(m.text())) return;
  const state = await page.evaluate(() => ({
    hash: location.hash, board: document.querySelector('.board')?.getBoundingClientRect().width,
    shown: !!document.querySelector('.cg-host')?.offsetParent, sel: document.querySelector('.opt.open .opt-roles')?.textContent,
  }));
  console.log(`[${Date.now() - t0}ms] NaN`, JSON.stringify(state));
});
await page.goto(site.url);
await page.waitForSelector('.game-row.demo');
if (process.env.DEMO_FIRST) {
  await page.locator('.game-row.demo').first().click();
  await page.waitForSelector('.moment-row');
  await page.locator('.moment-row').first().click();
  await page.waitForSelector('.options');
  console.log('demo visited; going back');
  t0 = Date.now();
  await page.goBack();
  await page.waitForSelector('.pgn-card summary');
}
const raw = JSON.parse(readFileSync(new URL('../data/games/174318730366.json', import.meta.url), 'utf-8'));
await page.locator('.pgn-card summary').click();
await page.fill('textarea.pgn', raw.pgn);
t0 = Date.now();
await page.locator('.pgn-card button[type=submit]').click();
await page.waitForSelector('.moment-row', { timeout: 120000 });
console.log('review done after', Date.now() - t0, 'ms');
await page.locator('.moment-row').first().click();
await page.waitForTimeout(500);
await browser.close();
site.close();
