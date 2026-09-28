// Render the PWA home-screen icons from favicon.svg.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(path.join(pub, 'favicon.svg'), 'utf8');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
for (const size of [192, 512]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `).replace('rx="7"', 'rx="0"')}</body>`);
  await page.screenshot({ path: path.join(pub, `icon-${size}.png`) });
}
await browser.close();
