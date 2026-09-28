// Capture README screenshots with a private headless Chrome, so a live crew's
// shared browser session is never touched. Uses the live stream, not a static render.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.FF_URL || 'http://127.0.0.1:4777';
const SPACE = process.env.FF_SPACE || '';
const TASK = process.env.FF_TASK || '';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = process.env.FF_ONLY ? process.env.FF_ONLY.split(',') : null;
mkdirSync(OUT, { recursive: true });

const sp = SPACE ? `&space=${SPACE}` : '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DESKTOP = { width: 1680, height: 1000, deviceScaleFactor: 2 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// Pretend a ship changes lane, purely in this headless page, to photograph a voyage.
const sail = (from, to) => `(() => {
  const t = S.board.tasks.find((x) => x.lane === '${from}' && (!S.space || x.repo === S.space));
  if (!t) return false;
  t.lane = '${to}';
  render();
  return true;
})()`;

const shots = [
  { name: 'harbor', hash: `view=harbor${sp}`, settle: 2500 },
  { name: 'harbor-manifest', hash: `view=harbor${sp}`, viewport: { width: 1680, height: 1000, deviceScaleFactor: 1 }, settle: 2500, act: async (p) => { await p.hover('.ship.lane-dev .plate'); await p.evaluate(() => document.querySelector('.ship.lane-dev').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))); await wait(300); } },
  { name: 'harbor-voyage', hash: `view=harbor${sp}`, settle: 2500, act: async (p) => { await p.evaluate(sail('dev', 'review')); await wait(1700); } },
  { name: 'harbor-docked', hash: `view=harbor${sp}`, settle: 2500, act: async (p) => { await p.evaluate(sail('dev', 'done')); await wait(3900); } },
  { name: 'harbor-zone', hash: `view=harbor${sp}`, settle: 2500, act: async (p) => { await p.click('.zone-label[data-zone=dev]'); await wait(700); } },
  { name: 'first-mate', hash: `view=harbor${sp}`, settle: 2500, act: async (p) => { await p.click('.flagship'); await wait(2500); } },
  { name: 'harbor-night', hash: `view=harbor${sp}&theme=dark`, settle: 2500 },
  { name: 'board', hash: `view=board${sp}` },
  { name: 'swimlanes', hash: `view=board&group=epic${sp}` },
  { name: 'card-page', hash: `view=board${sp}${TASK ? '&task=' + TASK : ''}`, settle: 2500, act: TASK ? null : async (p) => { await p.click('.col[data-lane=dev] .card'); await wait(2500); } },
  { name: 'epics', hash: `view=epics${sp}` },
  { name: 'fleet', hash: `view=fleet${sp}` },
  { name: 'fleet-log', hash: `view=log${sp}` },
  { name: 'phone-link', hash: `view=harbor${sp}`, settle: 2000, fakeRemote: true, act: async (p) => { await p.click('#phoneBtn'); await wait(1500); } },
  { name: 'phone-harbor', hash: `view=harbor${sp}`, viewport: PHONE, settle: 2000 },
  { name: 'phone-first-mate', hash: `view=harbor${sp}`, viewport: PHONE, settle: 2000, act: async (p) => { await p.click('.m-fm'); await wait(2500); } },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] });
try {
  for (const s of shots) {
    if (ONLY && !ONLY.includes(s.name)) continue;
    const page = await browser.newPage();
    await page.setViewport(s.viewport || DESKTOP);
    if (s.fakeRemote) {
      // Never photograph the real private key: serve a placeholder phone link instead.
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().endsWith('/api/remote')) {
          req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, control: true, lan: 'http://192.168.1.20:4777/?t=example-private-key' }) });
        } else req.continue();
      });
    }
    await page.goto(`${BASE}/#${s.hash}`, { waitUntil: 'domcontentloaded' });
    // Live terminals show a real private session: blur them in published screenshots.
    await page.addStyleTag({ content: 'pre.term { filter: blur(4px); }' });
    await page.waitForSelector('#view > *', { timeout: 15000 });
    await wait(s.settle || 900);
    if (s.act) await s.act(page);
    const file = path.join(OUT, `${s.name}.png`);
    await page.screenshot({ path: file, captureBeyondViewport: false });
    console.log(`  ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
}
