// shots.js — a picture of every screen, for looking at the design.
//
// Not a check: it asserts nothing and fails nothing. pagecheck.js proves the
// screens work; this one is for seeing whether they look right, which no
// assertion can tell you. Reuses pagecheck's server and Chromium lookup.
//
//   node shots.js            desktop width, both themes
//   node shots.js --mobile   390px, the width most students are on
//
// Pictures land in desktop/shots/ , which is not committed.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const answer = require('./shots-data');

const ROOT = path.join(__dirname, '..', 'frontend');
const OUT = path.join(__dirname, 'shots');
const PORT = Number(process.env.SHOTS_PORT || 8787);
const MOBILE = process.argv.includes('--mobile');
const DARK = process.argv.includes('--dark');   // the app's primary theme
const LIGHT = process.argv.includes('--light');  // the Daylight theme
const WATERMARK = process.argv.includes('--watermark');
const PALETTE = (process.argv.find(a => a.startsWith('--theme=')) || '').slice(8);  // any palette, e.g. --theme=ocean
const VIEWPORT = MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 };

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
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // Signed in, with the gate and the tour out of the way, and the help notes
  // already read — help.js shows each one once and never again, so a first
  // visit is not what the screens usually look like. Photographing it would
  // mean designing around a banner most students see for one day.
  await page.evaluate((seenKey) => {
    document.getElementById('entryGate')?.classList.add('hidden');
    document.getElementById('onboarding')?.classList.add('hidden');
    document.querySelector('.tour-backdrop')?.remove();
    try {
      const views = [...document.querySelectorAll('.view')].map(v => v.id.replace(/^view-/, ''));
      localStorage.setItem(seenKey, JSON.stringify(Object.fromEntries(views.map(v => [v, true]))));
    } catch { /* a profile without storage still photographs fine */ }
    window.Auth.getToken = () => 'shot-token';
    window.Auth.isLoggedIn = () => true;
    window.Auth.getUser = () => ({ id: 'u1', display_name: 'Мартин', role: 'student', grade: 8 });
  }, 'climby-help-seen');

  // the stand-in backend, so the layouts are judged with content in them
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.port === String(PORT)) return route.continue();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(answer(url.pathname)),
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    document.getElementById('entryGate')?.classList.add('hidden');
    document.getElementById('onboarding')?.classList.add('hidden');
    document.querySelector('.tour-backdrop')?.remove();
    window.Auth.getToken = () => 'shot-token';
    window.Auth.isLoggedIn = () => true;
    window.Auth.getUser = () => ({ id: 'u1', display_name: 'Мартин', role: 'student', grade: 8 });
  });
  await page.waitForTimeout(600);

  if (WATERMARK) await page.evaluate(() => window.Theme && Theme.setLook('watermark', 'on'));
  if (LIGHT || PALETTE) {
    await page.evaluate(p => window.Theme && Theme.setTheme(p), PALETTE || 'daylight');
    await page.waitForTimeout(300);
  }
  if (DARK) {
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.documentElement.classList.remove('light');
    });
    await page.waitForTimeout(300);
  }

  const views = await page.evaluate(() =>
    [...document.querySelectorAll('.view')].map(v => v.id.replace(/^view-/, '')));

  const tag = (MOBILE ? 'mobile' : 'desktop') + (WATERMARK ? '-wm' : '') + (DARK ? '-dark' : PALETTE ? '-' + PALETTE : LIGHT ? '-light' : '');
  for (const view of views) {
    await page.evaluate(v => window.Nav && Nav.activate(v), view);
    await page.waitForTimeout(400);
    const file = path.join(OUT, `${tag}-${view}.png`);
    await page.screenshot({ path: file });
    console.log('  ' + path.relative(process.cwd(), file));
  }

  // Settings, one picture per section, scrolled to its top — signed in, so
  // the account section is there too.
  await page.evaluate(() => {
    const u = { id: 'u1', display_name: 'Мартин', email: 'martin@example.com', role: 'student', grade: 8 };
    window.Auth.getUser = () => u;
    window.Auth.getRole = () => 'student';
    window.dispatchEvent(new CustomEvent('climby:auth-changed'));
    document.getElementById('settingsMenuBtn').click();
  });
  await page.waitForTimeout(500);
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('#settingsOverlay .settings-group:not(.hidden)')].map(g => g.id));
  for (const id of groups) {
    await page.evaluate(g => document.getElementById(g).scrollIntoView({ block: 'start' }), id);
    await page.waitForTimeout(300);
    const file = path.join(OUT, `${tag}-settings-${id}.png`);
    await page.screenshot({ path: file });
    console.log('  ' + path.relative(process.cwd(), file));
  }

  await browser.close();
  server.close();
  console.log(`${views.length} screens at ${VIEWPORT.width}x${VIEWPORT.height}`);
})().catch(e => { console.error(e.message); process.exit(1); });
