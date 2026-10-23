// The home-screen icons of the site (static/icons/*.png), drawn like the logo: the knight on
// the accent color. Usage: node scripts/make_icons.mjs   (needs Chromium, as web-tests/ do)
import { chromium } from 'playwright-core';
import { CHROMIUM } from '../web-tests/serve.mjs';

const OUT = new URL('../src/smartchess/web/static/icons/', import.meta.url);
// full: the color reaches the edges, for icons the system crops into its own shape
// (maskable on Android, rounded on iOS); the knight stays inside the middle 80%.
const ICONS = [
  { name: 'icon-192.png', size: 192, full: false },
  { name: 'icon-512.png', size: 512, full: true },
  { name: 'apple-touch-icon.png', size: 180, full: true },
];

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const page = await browser.newPage();
for (const { name, size, full } of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:#c2603f;border-radius:${full ? 0 : size * 0.22}px;
      color:#fff8ef;font:${size * (full ? 0.56 : 0.66)}px/1 'Segoe UI Symbol','Noto Sans Symbols 2','DejaVu Sans',serif">
      <span style="transform:translateY(-3%)">♞</span></div></body>`);
  await page.screenshot({ path: new URL(name, OUT).pathname.replace(/^\/(\w:)/, '$1'), omitBackground: true });
  console.log('wrote', name);
}
await browser.close();
