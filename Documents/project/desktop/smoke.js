// smoke.js — boot the packaged app and walk through it, for real.
//
// The Python suite runs on SQLite and a fake browser; the frontend checks are
// static. Neither ever launches Climby.exe, and neither ever sees a real
// camera. That is how a session could run for weeks throwing an error on
// every frame with 230 tests green. This does what a person does: starts the
// built app, opens every screen, the chat, Settings, and — if there is a
// camera — a focus session; and it fails on the first page error.
//
//   node smoke.js                 uses dist/win-unpacked/Climby.exe
//   node smoke.js path/to/app     any other build
//   SMOKE_EMAIL / SMOKE_PASSWORD  sign in first (optional; guest walk otherwise)
//
// Needs playwright-core and a Chromium for connectOverCDP; the app supplies
// its own runtime, so nothing is downloaded.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const exe = process.argv[2] || path.join(__dirname, 'dist', 'win-unpacked', 'Climby.exe');
const PORT = 9333;
const problems = [];

function note(kind, text) { problems.push(`${kind}: ${text}`); }

async function main() {
  if (!fs.existsSync(exe)) throw new Error(`no app at ${exe} — build first (npm run dist)`);
  const { chromium } = require('playwright-core');

  const profile = path.join(os.tmpdir(), 'climby-smoke-' + process.pid);
  const app = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { stdio: 'ignore', detached: false });
  const stop = () => {
    try { app.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', stop);

  // the port opens a second or two after the process does
  let browser = null;
  for (let i = 0; i < 30 && !browser; i++) {
    await new Promise(r => setTimeout(r, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
  }
  if (!browser) {
    const other = await new Promise(r => { const c = require('net').connect(PORT, '127.0.0.1'); c.on('connect', () => { c.end(); r(true); }); c.on('error', () => r(false)); });
    throw new Error(other ? `port ${PORT} is already in use — is another Climby running? Close it and try again`
                          : 'the app never opened its debugging port');
  }

  const page = browser.contexts()[0].pages()[0];
  page.on('pageerror', e => note('page error', e.message.slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') note('console error', m.text().slice(0, 200)); });
  page.on('requestfailed', r => { if (!/cdn\.jsdelivr|fonts\./.test(r.url())) note('request failed', r.url().slice(0, 120)); });

  await page.waitForTimeout(1500);
  const url = page.url();
  if (!url.startsWith('app://')) note('shell', `unexpected origin ${url}`);

  // Sign in through the real API if credentials were given; otherwise walk as a guest.
  const email = process.env.SMOKE_EMAIL, password = process.env.SMOKE_PASSWORD;
  if (email && password) {
    const backend = await page.evaluate(() => window.CLIMBY_BACKEND);
    const res = await page.request.post(backend + '/auth/login', { data: { email, password } });
    if (!res.ok()) note('sign-in', `login answered ${res.status()}`);
    else {
      const j = await res.json();
      await page.evaluate(j => { localStorage.setItem('climby-token', j.token); localStorage.setItem('climby-user', JSON.stringify(j.user)); }, j);
    }
  }
  await page.evaluate(() => { localStorage.setItem('climby-onboarding-seen', '1'); localStorage.setItem('climby-tour-seen', '1'); localStorage.setItem('climby-guest-skip', '1'); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Every screen, both themes.
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => localStorage.setItem('climby-theme', t), theme);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(800);
    for (const view of ['tutor', 'checklist', 'history', 'focus', 'family', 'classes']) {
      const link = page.locator(`.nav-link[data-view="${view}"]`).first();
      if (!(await link.count())) { note('nav', `no link for ${view}`); continue; }
      await link.click({ force: true });
      await page.waitForTimeout(500);
      const shown = await page.locator(`#view-${view}`).isVisible();
      if (!shown) note('nav', `${view} did not show (${theme})`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) note('layout', `horizontal overflow on ${view} (${theme})`);
    }
  }

  // The chat opens and closes.
  await page.locator('#aiFab').click({ force: true }); await page.waitForTimeout(400);
  if (!(await page.locator('#chatPanel').isVisible())) note('chat', 'panel did not open');
  await page.locator('#chatClose').click({ force: true }); await page.waitForTimeout(300);

  // Settings opens, shows the version, closes.
  await page.locator('#accountAvatar').click({ force: true }); await page.waitForTimeout(300);
  await page.locator('#settingsMenuBtn').click({ force: true }); await page.waitForTimeout(500);
  const version = await page.locator('#settingsVersion').innerText().catch(() => '');
  if (!/^\d+\.\d+\.\d+/.test(version)) note('settings', `version row shows "${version}"`);
  await page.locator('#settingsClose').click({ force: true }); await page.waitForTimeout(300);

  // A focus session, if this machine has a camera and we are signed in.
  const hasCamera = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).some(d => d.kind === 'videoinput'));
  const signedIn = await page.evaluate(() => !!localStorage.getItem('climby-token'));
  let focus = 'skipped (no camera or not signed in)';
  if (hasCamera && signedIn) {
    await page.locator('.nav-link[data-view="focus"]').first().click({ force: true }); await page.waitForTimeout(500);
    await page.evaluate(() => localStorage.setItem('climby-help-seen', JSON.stringify({ focus: true })));
    if (!(await page.locator('#focusEnableToggle').isChecked())) { await page.locator('label.switch').first().click(); await page.waitForTimeout(600); }
    const before = problems.length;
    await page.locator('button:has-text("Start session"), button:has-text("Започни сесия")').first().click({ force: true });
    await page.waitForTimeout(12000);
    const running = await page.locator('#view-focus').innerText();
    if (!/Session running|Сесията върви/.test(running)) note('focus', 'session did not start');
    await page.locator('button:has-text("End session"), button:has-text("Край на сесията")').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
    focus = problems.length === before ? 'ran 12s with no errors' : 'errors during session (see above)';
  }

  await browser.close();
  stop();

  console.log(`app:      ${exe}`);
  console.log(`version:  ${version || '?'}`);
  console.log(`focus:    ${focus}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of [...new Set(problems)]) console.log('  - ' + p);
    process.exit(1);
  }
  console.log('\nsmoke: clean');
}

main().catch(e => { console.error('smoke failed:', e.message); process.exit(2); });
