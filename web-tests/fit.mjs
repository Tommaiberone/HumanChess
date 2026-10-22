// Does the review fit one phone screen? For several phone sizes, open every key moment of the
// demo, every option, the intro and the move list, and report how many pixels of the panel
// (and of the page) do not fit. Usage: node web-tests/fit.mjs [SHOT_DIR]
import { chromium } from 'playwright-core';
import { CHROMIUM, serve } from './serve.mjs';

const site = await serve();
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const SIZES = [[360, 640], [375, 667], [390, 844], [412, 915], [430, 932]];
const worst = [];
for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(site.url);
  await page.waitForSelector('.game-row.demo');
  await page.locator('.game-row.demo').first().click();
  await page.waitForSelector('.moment-row');
  const measure = label => page.evaluate(label => {
    const panes = document.querySelector('.panes');
    return { label, panel: panes.scrollHeight - panes.clientHeight, page: document.documentElement.scrollHeight - innerHeight, panelH: panes.clientHeight };
  }, label);
  const rows = [await measure('intro')];
  const moments = await page.locator('.moment-row').count();
  for (let m = 0; m < moments; m++) {
    await page.locator('.moment-row').nth(m).click().catch(async () => { await page.keyboard.press('n'); });
    await page.waitForSelector('.options');
    const heads = await page.locator('.opt-head').count();
    for (let o = 0; o < heads; o++) {
      await page.locator('.opt-head').nth(o).click();
      rows.push(await measure(`moment ${m + 1} option ${o + 1}`));
    }
    await page.keyboard.press('Escape');
    // back to the intro list: jump to the start
    await page.keyboard.press('Home');
    await page.waitForSelector('.moment-row');
  }
  await page.locator('.icon-btn.compact-only').click();
  rows.push(await measure('moves'));
  const over = rows.filter(r => r.panel > 0);
  console.log(`${w}x${h}: board ${await page.evaluate(() => Math.round(document.querySelector('.board').getBoundingClientRect().width))}px, panel ${rows[0].panelH}px high, ` +
    `${over.length}/${rows.length} views overflow` + (over.length ? ` (worst +${Math.max(...over.map(r => r.panel))}px: ${over.sort((a, b) => b.panel - a.panel)[0].label})` : '') +
    `, page scroll ${Math.max(...rows.map(r => r.page))}px`);
  if (process.env.DETAIL && w === +process.env.DETAIL) console.log(rows.map(r => r.label + ' +' + r.panel).join(' | '));
  if (process.argv[2] && w === 390) await page.screenshot({ path: `${process.argv[2]}/fit-390.png` });
  await ctx.close();
}
await browser.close(); site.close();
