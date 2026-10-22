// Screenshots of the exported site at a given viewport. Usage: node web-tests/shot.mjs OUT_DIR WIDTH HEIGHT [demo|home|about]
import { chromium } from 'playwright-core';
import { CHROMIUM, serve } from './serve.mjs';

const [outDir, w, h, what = 'demo'] = process.argv.slice(2);
const site = await serve();
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(site.url);
await page.waitForSelector('.game-row');
const shot = async name => {
  const m = await page.evaluate(() => ({ scrollH: document.documentElement.scrollHeight, innerH: innerHeight, scrollW: document.documentElement.scrollWidth, innerW: innerWidth }));
  console.log(name, JSON.stringify(m));
  await page.screenshot({ path: `${outDir}/${name}-${w}x${h}.png` });
};
if (what === 'home') await shot('home');
if (what === 'about') { await page.goto(page.url() + '#/about'); await page.waitForTimeout(300); await shot('about'); }
if (what === 'demo') {
  await page.locator('.game-row.demo').first().click();
  await page.waitForSelector('.moment-row');
  await shot('review-intro');
  await page.locator('.moment-row').first().click();
  await page.waitForSelector('.options');
  await shot('review-moment');
  await page.locator(+w <= 760 || +h <= 520 ? '.icon-btn.compact-only' : '.tab >> text=Moves').click();
  await shot('review-moves');
}
await browser.close(); site.close();
