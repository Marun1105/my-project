// pagecheck.js — open the frontend in a real browser and fail on anything wrong.
//
// smoke.js boots the packaged app, which takes a build. This is the fast one:
// it serves ../frontend over a local port, loads it in headless Chromium, walks
// every screen and exercises the small pieces that static checks cannot see.
//
// It exists because of a bug static checks could never have caught. The
// show/hide button on the password fields was in the DOM, measured 36 pixels
// wide, and rendered as nothing at all: the app's global `button` rule carries
// padding meant for full-width buttons, which left the icon a content box of
// zero width. Every check said it was there. It was invisible.
//
//   npm run pagecheck
//
// Chromium comes from the Playwright cache. If it is not there:
//   npx playwright install chromium
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..', 'frontend');
const PORT = Number(process.env.PAGECHECK_PORT || 8779);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    // nothing outside the frontend folder gets served, even by a crafted path
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
  });
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(process.env.LOCALAPPDATA || process.env.HOME || '', 'ms-playwright');
  if (!fs.existsSync(cache)) return null;
  const builds = fs.readdirSync(cache).filter(d => d.startsWith('chromium-')).sort().reverse();
  for (const b of builds) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(cache, b, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

(async () => {
  const executablePath = findChromium();
  if (!executablePath) {
    console.error('No Chromium found. Run:  npx playwright install chromium');
    process.exit(2);
  }

  const server = await serve();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];

  page.on('pageerror', e => problems.push('page error: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // no backend is running here, so a failed call to it is expected and fine
    if (/Failed to load resource|ERR_CONNECTION|net::/.test(text)) return;
    problems.push('console error: ' + text);
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // the sign-in gate stands in front of everything
  await page.evaluate(() => {
    document.getElementById('entryGate')?.classList.add('hidden');
    document.getElementById('onboarding')?.classList.add('hidden');
  });
  await page.waitForTimeout(300);

  const views = await page.evaluate(() =>
    [...document.querySelectorAll('.view')].map(v => v.id.replace(/^view-/, '')));
  for (const view of views) {
    await page.evaluate(v => window.Nav && Nav.activate(v), view);
    await page.waitForTimeout(150);
  }

  // back must land on a screen, not outside the app
  await page.goBack().catch(() => {});
  await page.waitForTimeout(300);
  if (!(await page.evaluate(() => window.Nav && Nav.currentView()))) {
    problems.push('back navigation left no screen showing');
  }

  const wired = await page.evaluate(() => ({
    toast: typeof window.Toast?.show === 'function',
    copy: typeof window.Copy?.attach === 'function',
    eyes: document.querySelectorAll('.password-eye').length,
    growable: getComputedStyle(document.getElementById('chatInput')).resize === 'none',
  }));
  if (!wired.toast) problems.push('Toast.show is missing');
  if (!wired.copy) problems.push('Copy.attach is missing');
  if (!wired.eyes) problems.push('no password field got a show/hide button');
  if (!wired.growable) problems.push('the chat box is still a fixed-size textarea');

  // a toast appears, carries its action, and goes away again
  await page.evaluate(() => Toast.show('check', { action: { label: 'Undo', onClick: () => {} }, timeout: 600 }));
  await page.waitForTimeout(150);
  if (!(await page.locator('.toast-action').count())) problems.push('the toast action button did not render');
  await page.waitForTimeout(1200);
  if (await page.locator('.toast').count()) problems.push('the toast never left');

  // the offline bar follows the browser's own answer, both ways
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForTimeout(250);
  if (!(await page.locator('.offline-bar:not(.hidden)').count())) problems.push('going offline showed nothing');
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(250);
  if (await page.locator('.offline-bar:not(.hidden)').count()) problems.push('the offline bar stayed up after coming back');

  // the bug this file was written for: an icon with nowhere to draw itself
  const squashed = await page.evaluate(() => {
    const bad = [];
    for (const svg of document.querySelectorAll('button svg, a svg')) {
      if (!svg.getClientRects().length) continue;   // inside a panel that is closed
      const r = svg.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) {
        const owner = svg.closest('button, a');
        bad.push(`${owner.id || owner.className || owner.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return bad;
  });
  for (const s of squashed) problems.push('icon collapsed to nothing: ' + s);

  // the focus trap: into an open panel, never out of it, and back afterwards
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[id]')].find(el => el.getClientRects().length);
    b.focus();
    window.__opener = b.id;
    document.getElementById('settingsOverlay').classList.remove('hidden');
  });
  await page.waitForTimeout(250);
  if (!(await page.evaluate(() => document.getElementById('settingsOverlay').contains(document.activeElement)))) {
    problems.push('opening Settings did not move focus into it');
  }
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() =>
      document.getElementById('settingsOverlay').contains(document.activeElement));
    if (!inside) { problems.push('Tab walked out of the open Settings panel'); break; }
  }
  await page.evaluate(() => document.getElementById('settingsOverlay').classList.add('hidden'));
  await page.waitForTimeout(250);
  if (!(await page.evaluate(() => document.activeElement.id === window.__opener))) {
    problems.push('closing Settings dropped focus instead of handing it back');
  }

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
  await browser.close();
  server.close();

  if (problems.length) {
    console.log('PROBLEMS:\n' + problems.map(p => '  - ' + p).join('\n'));
    process.exit(1);
  }
  console.log(`page check clean: ${views.length} screens, ${wired.eyes} password fields`);
})().catch(err => { console.error(err); process.exit(1); });
