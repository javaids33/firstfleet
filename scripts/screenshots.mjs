// Capture README screenshots with a private headless Chrome, so a live crew's
// shared browser session is never touched. Uses the live stream, not a static render.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.FF_URL || 'http://127.0.0.1:4777';
const SPACE = process.env.FF_SPACE || '';
const TASK = process.env.FF_TASK || 's3-hud';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

const sp = SPACE ? `&space=${SPACE}` : '';
const shots = [
  ['board', `view=board${sp}`],
  ['swimlanes', `view=board&group=epic${sp}`],
  ['backlog', `view=backlog${sp}`],
  ['epics', `view=epics${sp}`],
  ['fleet', `view=fleet${sp}`],
  ['fleet-log', `view=log${sp}`],
  ['card-page', `view=board${sp}&task=${TASK}`],
  ['board-dark', `view=board${sp}&theme=dark`],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1000, deviceScaleFactor: 2 });
  for (const [name, hash] of shots) {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view > *', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, name === 'card-page' ? 1500 : 800));
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${file}`);
  }
} finally {
  await browser.close();
}
