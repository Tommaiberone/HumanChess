// How the review uses a phone screen. For several viewports (the room a phone browser
// really leaves, with its bars, and one home-screen app), open every key moment of the
// demo and every card, and report: the board's width against the screen's, whether the
// page scrolls (it must not), the smallest text in the panel and the controls, and in how
// many views the explanation starts out of sight (the panel scrolls, the board stays).
// Usage: node web-tests/fit.mjs [SHOT_DIR]
import { chromium } from 'playwright-core';
import { CHROMIUM, serve } from './serve.mjs';

const site = await serve();
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const SIZES = [
  [375, 548, 'iPhone SE, Safari'],
  [390, 664, 'iPhone 13-16, Safari'],
  [430, 740, 'iPhone Pro Max, Safari'],
  [360, 660, 'small Android, Chrome'],
  [412, 780, 'Pixel, Chrome'],
  [390, 844, 'iPhone, home-screen app'],
  [740, 340, 'iPhone on its side, Safari'],
];
let failed = false;
for (const [w, h, label] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(site.url);
  await page.waitForSelector('.game-row.demo');
  await page.locator('.game-row.demo').first().click();
  await page.waitForSelector('.moment-row');
  const measure = name => page.evaluate(name => {
    const panes = document.querySelector('.panes');
    const box = panes.getBoundingClientRect();
    const body = document.querySelector('.opt-body');
    // The smallest font among the visible texts of the panel and the controls.
    // (The "!" and "?!" drawn inside the class badges are pictures, not text to read.)
    let font = Infinity, smallest = '';
    for (const e of document.querySelectorAll('.side-col *, .controls *')) {
      if (e.closest('svg') || ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || !e.getClientRects().length) continue;
      const size = parseFloat(getComputedStyle(e).fontSize);
      if (size < font) { font = size; smallest = `${e.className || e.tagName} "${e.textContent.trim().slice(0, 30)}"`; }
    }
    return {
      name, font, smallest,
      page: document.documentElement.scrollHeight - innerHeight,
      // The first line of the explanation is in view if it ends above the fade at the bottom of the panel.
      hidden: body ? body.getBoundingClientRect().top + 46 > box.bottom : false,
    };
  }, name);
  const rows = [await measure('intro')];
  const moments = await page.locator('.moment-row').count();
  for (let m = 0; m < moments; m++) {
    await page.locator('.moment-row').nth(m).click();
    await page.waitForSelector('.options');
    const heads = await page.locator('.opt-head').count();
    for (let o = 0; o < heads; o++) {
      await page.locator('.opt-head').nth(o).click();
      rows.push(await measure(`moment ${m + 1} card ${o + 1}`));
    }
    await page.keyboard.press('Home');
    await page.waitForSelector('.moment-row');
  }
  await page.locator('.icon-btn.compact-only').click();
  rows.push(await measure('moves'));
  const s = await page.evaluate(() => ({
    board: document.querySelector('.board').getBoundingClientRect().width,
    panel: document.querySelector('.panes').clientHeight,
    tap: Math.min(...[...document.querySelectorAll('.controls .icon-btn')].filter(b => b.getClientRects().length).map(b => b.offsetHeight)),
  }));
  const hidden = rows.filter(r => r.hidden);
  const scroll = Math.max(...rows.map(r => r.page));
  const font = Math.min(...rows.map(r => r.font));
  const side = Math.min(w, h);
  console.log(`${`${w}x${h}`.padEnd(8)} ${label.padEnd(27)} board ${Math.round(s.board)}px (${Math.round((s.board / side) * 100)}% of the short side), ` +
    `panel ${s.panel}px, smallest text ${font}px, buttons ${s.tap}px, page scroll ${scroll}px, ` +
    `explanation out of sight in ${hidden.length}/${rows.length - 2} views`);
  if (process.env.DETAIL && w === +process.env.DETAIL) {
    console.log('   smallest:', rows.find(r => r.font === font).smallest, '| explanation out of sight:', hidden.map(r => r.name).join(', ') || 'none');
  }
  if (scroll > 0 || font < 12) failed = true;
  if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/fit-${w}x${h}.png` });
  await ctx.close();
}
await browser.close(); site.close();
if (failed) { console.log('FAIL: the page scrolls or a text is under 12px'); process.exit(1); }
