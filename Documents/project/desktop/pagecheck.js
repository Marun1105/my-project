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
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.svg': 'image/svg+xml',
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

  await page.addInitScript(() => {
    window.__updateStatusHandlers = [];
    window.CLIMBY_DESKTOP = {
      isDesktop: true,
      version: () => Promise.resolve('1.0.21'),
      checkForUpdates: () => Promise.resolve('checking'),
      onUpdateStatus: handler => window.__updateStatusHandlers.push(handler),
    };
  });
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
    faceVerification: typeof window.FaceVerification?.createMonitor === 'function',
    focusVerification: !!document.querySelector('.focus-verify-notice') &&
      !document.querySelector('#focusVerifyToggle') &&
      !!document.querySelector('#focusVerifyPaused[role="alert"]'),
    focusStartCheck: !!document.querySelector('#focusIdentityCheck[role="status"][aria-live="polite"]') &&
      !!document.querySelector('#focusIdentityStep') &&
      document.querySelectorAll('#focusIdentityCheck [data-check-step]').length === 3 &&
      document.querySelector('#focusIdentityCheck [role="progressbar"]')?.getAttribute('aria-valuemax') === '3',
    focusLoadingPrivacy: !!document.querySelector('#focusLoading [data-i18n="focus.startPrivacy"]') &&
      !!document.querySelector('#focusLoading .focus-start-progress.is-indeterminate'),
    usernameLogin: document.getElementById('loginEmail')?.type === 'text' &&
      document.getElementById('loginEmail')?.autocomplete === 'username',
    // optional since 1.0.26: SMS is not configured, and a phone was never
    // something a 12-year-old should have to give
    optionalRegistrationPhone: document.getElementById('registerPhone')?.required === false,
    registrationSmsStep: !!document.getElementById('verifyPhoneForm') &&
      !!document.getElementById('verifyPhoneCode') &&
      !!document.getElementById('resendPhoneCodeLink'),
    honestSecurityNote: /not end-to-end/i.test(
      document.querySelector('.auth-security-note')?.textContent || ''
    ),
  }));
  if (!wired.toast) problems.push('Toast.show is missing');
  if (!wired.copy) problems.push('Copy.attach is missing');
  if (!wired.eyes) problems.push('no password field got a show/hide button');
  if (!wired.growable) problems.push('the chat box is still a fixed-size textarea');
  if (!wired.faceVerification) problems.push('the local face-verification module did not load');
  if (!wired.focusVerification) problems.push('the required Focus face-check notice or pause controls are missing');
  if (!wired.focusStartCheck) problems.push('the session-start face check is missing accessible progress UI');
  if (!wired.focusLoadingPrivacy) problems.push('the camera/model loading state is missing privacy and progress cues');
  if (!wired.usernameLogin) problems.push('sign-in does not accept an email or username identifier');
  if (!wired.optionalRegistrationPhone) problems.push('registration phone is marked required again');
  if (!wired.registrationSmsStep) problems.push('the registration SMS verify/resend step is missing');
  if (!wired.honestSecurityNote) problems.push('the security note omits its encryption limits');

  const activityPlayback = await page.evaluate(async () => {
    const activity = AIActivity.create('thinking', 'Thinking…');
    document.body.appendChild(activity);
    const video = activity.querySelector('video');
    const poster = activity.querySelector('img');
    video.play().catch(() => {});
    const playback = await Promise.race([
      new Promise(resolve => video.addEventListener('playing', () => resolve('playing'), { once: true })),
      new Promise(resolve => video.addEventListener('error', () => resolve('error'), { once: true })),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    const result = {
      playback,
      muted: video.muted,
      loops: video.loop,
      posterLoaded: poster.complete && poster.naturalWidth > 0,
      source: video.currentSrc,
      readyState: video.readyState,
      networkState: video.networkState,
      mediaError: video.error?.code || null,
      canPlayWebm: video.canPlayType('video/webm; codecs="vp8"'),
    };
    activity.remove();
    return result;
  });
  if (activityPlayback.playback !== 'playing') {
    problems.push('the ClimbAI waiting animation did not play in the browser: ' + JSON.stringify(activityPlayback));
  }
  if (!activityPlayback.muted || !activityPlayback.loops) {
    problems.push('the ClimbAI waiting animation is not muted and looping');
  }
  if (!activityPlayback.posterLoaded) problems.push('the ClimbAI waiting animation poster did not load');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotionFallback = await page.evaluate(() => {
    const activity = AIActivity.create('reading', 'Reading the page…');
    const result = !activity.querySelector('video') &&
      activity.querySelector('img')?.getAttribute('src') === 'media/climbai-reading-poster.jpg';
    activity.remove();
    return result;
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (!reducedMotionFallback) problems.push('reduced motion did not use the static ClimbAI poster');

  const memoryControls = await page.evaluate(() => {
    const ids = ['memoryGrade', 'memoryChecklist', 'memoryFocus', 'memoryQuestions', 'memoryPersonal'];
    const personal = document.getElementById('memoryPersonal');
    const note = document.getElementById('memoryPersonalNote');
    const clear = document.getElementById('memoryClear');
    localStorage.removeItem('climby-memory-v1:guest');
    Memory.render();
    const defaultsOff = ids.every(id => !document.getElementById(id).checked) && note.disabled;
    const guestLocked = ids.every(id => document.getElementById(id).disabled) &&
      !document.getElementById('memoryLoginHint').classList.contains('hidden');
    const originalGetUser = Auth.getUser;
    const originalIsLoggedIn = Auth.isLoggedIn;
    Auth.getUser = () => ({ id: 'memory-check-user' });
    Auth.isLoggedIn = () => true;
    localStorage.removeItem('climby-memory-v1:memory-check-user');
    Memory.render();
    document.getElementById('memoryChecklist').checked = true;
    document.getElementById('memoryChecklist').dispatchEvent(new Event('change', { bubbles: true }));
    const selectedOnly = Memory.request().checklist &&
      !Memory.request().learning_level && !Memory.request().focus_sessions &&
      !Memory.request().previous_questions;
    document.getElementById('memoryGrade').checked = true;
    document.getElementById('memoryGrade').dispatchEvent(new Event('change', { bubbles: true }));
    const gradeRoundTrip = Memory.request().learning_level &&
      JSON.parse(localStorage.getItem('climby-memory-v1:memory-check-user')).learning_level === true;
    personal.checked = true;
    personal.dispatchEvent(new Event('change', { bubbles: true }));
    const noteEnabled = !note.disabled;
    note.value = 'Use visual examples.';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    const noteSentWhenSelected = Memory.request().personal_note === 'Use visual examples.';
    personal.checked = false;
    personal.dispatchEvent(new Event('change', { bubbles: true }));
    const noteOmittedWhenDisabled = Memory.request().personal_note === '';
    clear.click();
    const cleared = ids.every(id => !document.getElementById(id).checked) &&
      note.value === '' && note.disabled && !Memory.isEnabled();
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('climby-memory-v1:')) throw new Error('storage unavailable');
      return originalSetItem.call(this, key, value);
    };
    document.getElementById('memoryChecklist').checked = true;
    document.getElementById('memoryChecklist').dispatchEvent(new Event('change', { bubbles: true }));
    const storageFailureVisible = !document.getElementById('memoryStorageError').classList.contains('hidden');
    Storage.prototype.setItem = originalSetItem;
    clear.click();
    Auth.getUser = originalGetUser;
    Auth.isLoggedIn = originalIsLoggedIn;
    Memory.render();
    return { defaultsOff, guestLocked, selectedOnly, gradeRoundTrip, noteEnabled, noteSentWhenSelected, noteOmittedWhenDisabled, cleared, storageFailureVisible };
  });
  for (const [check, passed] of Object.entries(memoryControls)) {
    if (!passed) problems.push('ClimbAI memory control failed: ' + check);
  }
  await page.evaluate(() => document.getElementById('chatMemoryManage').click());
  await page.waitForTimeout(150);
  if (await page.locator('#settingsOverlay.hidden').count()) {
    problems.push('the chat memory manage button did not open Settings');
  }
  await page.evaluate(() => document.getElementById('settingsClose').click());

  const loading = await page.evaluate(async () => {
    const progress = Loading.begin('loading.ai');
    await new Promise(resolve => setTimeout(resolve, 420));
    const remainsInContext = document.getElementById('netWakeStatus').classList.contains('hidden');
    progress.update('net.waking');
    await new Promise(resolve => setTimeout(resolve, 420));
    const wakeNoticeVisible = !document.getElementById('netWakeStatus').classList.contains('hidden');
    const message = document.getElementById('netWakeMessage').textContent;
    progress.end();
    await new Promise(resolve => setTimeout(resolve, 750));
    return { remainsInContext, wakeNoticeVisible, message, hiddenAfter: document.getElementById('netWakeStatus').classList.contains('hidden') };
  });
  if (!loading.remainsInContext) problems.push('an ordinary AI wait showed the backend-waking notice');
  if (!loading.wakeNoticeVisible) problems.push('the compact backend-waking notice did not appear');
  if (!loading.message || loading.message === 'net.waking') problems.push('the waking notice did not show translated text');
  if (!loading.hiddenAfter) problems.push('the backend-waking notice stayed open after the request finished');

  const wakeNoticeSettlesDuringOtherRequests = await page.evaluate(async () => {
    const wake = Loading.begin();
    wake.update('net.waking');
    await new Promise(resolve => setTimeout(resolve, 400));
    wake.end();
    const unrelated = Loading.begin('loading.generic');
    await new Promise(resolve => setTimeout(resolve, 750));
    const hidden = document.getElementById('netWakeStatus').classList.contains('hidden');
    unrelated.end();
    return hidden;
  });
  if (!wakeNoticeSettlesDuringOtherRequests) {
    problems.push('the backend-waking notice stayed open after another request started');
  }

  await page.evaluate(() => document.getElementById('settingsUpdateBtn').click());
  await page.waitForTimeout(100);
  if (!(await page.locator('#settingsUpdateBtn').isDisabled())) {
    problems.push('the update button did not enter its checking state');
  }
  await page.evaluate(() => window.__updateStatusHandlers.forEach(handler => handler({ status: 'current' })));
  if (await page.locator('#settingsUpdateBtn').isDisabled()) {
    problems.push('the update button stayed disabled after the check completed');
  }
  if (!(await page.locator('#settingsUpdateStatus').innerText()).includes('up to date')) {
    problems.push('the update check result was not shown in Settings');
  }

  const requiredFaceCheck = await page.evaluate(() => {
    const copy = document.querySelector('.focus-verify-notice')?.innerText || '';
    return !document.getElementById('focusVerifyToggle') &&
      copy.toLowerCase().includes('required');
  });
  if (!requiredFaceCheck) problems.push('Focus no longer communicates that its face check is required');

  const focusDesktopLayout = await page.evaluate(() => {
    Nav.activate('focus');
    const layout = document.querySelector('.focus-layout');
    const intro = document.querySelector('.focus-intro');
    const history = document.querySelector('.session-history');
    return {
      columns: getComputedStyle(layout).gridTemplateColumns,
      introWidth: intro.getBoundingClientRect().width,
      layoutWidth: layout.getBoundingClientRect().width,
      historyHidden: history.classList.contains('hidden'),
    };
  });
  if (focusDesktopLayout.historyHidden &&
      (focusDesktopLayout.columns !== 'none' || focusDesktopLayout.introWidth < focusDesktopLayout.layoutWidth * 0.8)) {
    problems.push('the guest Focus intro is narrow or reserves an empty history column');
  }
  const focusHistoryLayout = await page.evaluate(() => {
    const layout = document.querySelector('.focus-layout');
    const history = document.querySelector('.session-history');
    history.classList.remove('hidden');
    const display = getComputedStyle(layout).display;
    history.classList.add('hidden');
    return display;
  });
  if (focusHistoryLayout !== 'grid') {
    problems.push('the Focus timer and session history do not share a desktop layout when history is available');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => {
    document.getElementById('entryGate')?.classList.add('hidden');
    document.getElementById('onboarding')?.classList.add('hidden');
    document.querySelectorAll('.tour-popover,.tour-backdrop').forEach(el => el.classList.add('hidden'));
    Nav.activate('focus');
    const intro = document.querySelector('.focus-intro');
    const ring = document.querySelector('.focus-ring');
    const mark = document.querySelector('.mobile-brand-mark');
    const focusRunning = document.getElementById('focusRunning');
    const identityCheck = document.getElementById('focusIdentityCheck');
    focusRunning.classList.remove('hidden');
    identityCheck.classList.remove('hidden');
    const identityRect = identityCheck.getBoundingClientRect();
    const identityCheckLayout = {
      left: identityRect.left,
      right: identityRect.right,
      width: identityRect.width,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
    focusRunning.classList.add('hidden');
    identityCheck.classList.add('hidden');
    return {
      focusColumns: getComputedStyle(intro).gridTemplateColumns.trim().split(/\s+/).length,
      focusRingColumn: getComputedStyle(ring).gridColumnStart,
      brandMarkVisible: mark.getBoundingClientRect().width > 0 && mark.complete && mark.naturalWidth > 0,
      identityCheckLayout,
    };
  });
  if (mobileLayout.focusColumns !== 1 || mobileLayout.focusRingColumn !== '1') {
    problems.push('the Focus intro does not collapse to a single mobile column');
  }
  if (!mobileLayout.brandMarkVisible) problems.push('the mobile app bar does not show its brand mark');
  if (mobileLayout.identityCheckLayout.left < 0 ||
      mobileLayout.identityCheckLayout.right > mobileLayout.identityCheckLayout.viewportWidth + 1 ||
      mobileLayout.identityCheckLayout.pageWidth > mobileLayout.identityCheckLayout.viewportWidth + 1) {
    problems.push('the Focus face-check card overflows the mobile viewport');
  }
  const mobileViewWidths = await page.evaluate(() => {
    const views = [...document.querySelectorAll('.view')];
    return views.map(view => {
      Nav.activate(view.id.replace(/^view-/, ''));
      return {
        view: view.id,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        viewWidth: view.getBoundingClientRect().width,
      };
    });
  });
  for (const layout of mobileViewWidths) {
    if (layout.pageWidth > layout.viewportWidth + 1 || layout.viewWidth > layout.viewportWidth + 1) {
      problems.push(`the ${layout.view} view overflows the mobile viewport`);
    }
  }
  await page.evaluate(() => document.getElementById('accountBtn').click());
  await page.evaluate(() => document.getElementById('settingsMenuBtn').click());
  const settingsMobileLayout = await page.evaluate(() => ({
    locked: document.documentElement.classList.contains('settings-open'),
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    panelWidth: document.querySelector('.settings-card').getBoundingClientRect().width,
  }));
  await page.evaluate(() => document.getElementById('settingsClose').click());
  const settingsUnlocksPage = await page.evaluate(() => !document.documentElement.classList.contains('settings-open'));
  if (!settingsMobileLayout.locked || !settingsUnlocksPage) problems.push('Settings does not lock and restore background scrolling');
  if (settingsMobileLayout.pageWidth > settingsMobileLayout.viewportWidth + 1 ||
      settingsMobileLayout.panelWidth > settingsMobileLayout.viewportWidth + 1) {
    problems.push('Settings overflows the mobile viewport');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

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

  // The tutor offering homework to the Route, with the Route and the tutor
  // both faked — this is about the wiring, not the network. Worth having here
  // because every part of it is a place a student would see the failure: a
  // card that never appears, a button that adds nothing, an Undo that leaves
  // the task behind, or a "yes" that quietly buys another answer.
  await page.evaluate(() => {
    window.__route = [];
    window.__asks = 0;
    window.Checklist.addTask = (text, subject, deadline) => {
      window.__route.push({ text, subject, deadline });
      return Promise.resolve();
    };
    window.Checklist.removeNewestMatching = (text) => {
      const i = window.__route.map(t => t.text).lastIndexOf(text);
      if (i >= 0) window.__route.splice(i, 1);
      return Promise.resolve(i >= 0);
    };
    window.Auth.getToken = () => 'fake-token';
    window.fetch = () => {
      window.__asks++;
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          answer: 'Maths first, then. Shall I put it on your Route?',
          suggestions: [{ text: 'Maths — exercises 4-6', subject: 'Maths', deadline: '2030-05-20' }],
        }),
      });
    };
    document.getElementById('aiFab').click();
  });
  await page.waitForTimeout(300);

  await page.fill('#chatInput', 'I have maths for tomorrow');
  await page.click('#chatSend');
  await page.waitForTimeout(600);
  if (!(await page.locator('.suggest-card').count())) problems.push('the tutor offered no task card');
  if (/climby-task|```/.test(await page.locator('#chatLog').innerText())) {
    problems.push('the task block leaked into the chat');
  }

  await page.click('.suggest-add');
  await page.waitForTimeout(400);
  if ((await page.evaluate(() => window.__route.length)) !== 1) problems.push('Add put nothing on the Route');
  if (!(await page.locator('.toast-action').count())) problems.push('adding offered no Undo');

  await page.click('.toast-action');
  await page.waitForTimeout(400);
  if ((await page.evaluate(() => window.__route.length)) !== 0) problems.push('Undo left the task on the Route');

  // a typed yes takes the offer without buying an answer to say "done"
  await page.fill('#chatInput', 'and history reading');
  await page.click('#chatSend');
  await page.waitForTimeout(600);
  const asksBefore = await page.evaluate(() => window.__asks);
  await page.fill('#chatInput', 'yes');
  await page.click('#chatSend');
  await page.waitForTimeout(500);
  if ((await page.evaluate(() => window.__asks)) !== asksBefore) problems.push('"yes" cost an AI call');
  if ((await page.evaluate(() => window.__route.length)) !== 1) problems.push('"yes" added nothing');

  // and an ordinary question still reaches the tutor
  const asksNow = await page.evaluate(() => window.__asks);
  await page.fill('#chatInput', 'what is a prime number?');
  await page.click('#chatSend');
  await page.waitForTimeout(500);
  if ((await page.evaluate(() => window.__asks)) !== asksNow + 1) {
    problems.push('an ordinary question stopped reaching the tutor');
  }

  // The phone page's focus picking. It lives outside ../frontend and ships with
  // the backend, but this is the only place its logic can actually be run: the
  // functions sit inside an IIFE, so their real source is lifted out of the
  // file and exercised here rather than a copy of it being tested.
  const phoneSrc = fs.readFileSync(path.join(__dirname, '..', 'phone_page.html'), 'utf8');
  const lift = (opening) => {
    const at = phoneSrc.indexOf(opening);
    if (at < 0) return null;
    return phoneSrc.slice(at, phoneSrc.indexOf('\n  }', at) + 4);
  };
  const sharpnessSrc = lift('function sharpness(canvas) {');
  const burstSrc = lift('function grabBestFrame() {');
  if (!sharpnessSrc || !burstSrc) {
    problems.push('the phone page no longer has sharpness()/grabBestFrame() where they were');
  } else {
    const phone = await page.evaluate(async ({ sharpnessSrc, burstSrc }) => {
      eval(sharpnessSrc);
      const draw = (blurPx, label) => {
        const c = document.createElement('canvas');
        c.width = 800; c.height = 500;
        const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        x.filter = blurPx ? `blur(${blurPx}px)` : 'none';
        x.fillStyle = '#111'; x.font = '24px serif';
        for (let i = 0; i < 12; i++) x.fillText('S_ABC = 24 cm2 ' + label, 30, 40 + i * 36);
        c.__label = label;
        return c;
      };
      const crisp = sharpness(draw(0, 'x'));
      const soft = sharpness(draw(6, 'y'));
      // a camera that only settles on the third frame
      const frames = [draw(7, 'a'), draw(5, 'b'), draw(0, 'SHARP'), draw(6, 'd')];
      let i = 0;
      function grabFrame() { return frames[i++] || null; }
      eval(burstSrc);
      const picked = await grabBestFrame();
      return { crisp, soft, picked: picked && picked.__label };
    }, { sharpnessSrc, burstSrc });

    if (!(phone.crisp > phone.soft * 3)) {
      problems.push(`sharpness cannot separate a crisp page from a blurred one (${Math.round(phone.crisp)} vs ${Math.round(phone.soft)})`);
    }
    if (phone.picked !== 'SHARP') {
      problems.push(`the phone burst picked the ${phone.picked} frame, not the focused one`);
    }
  }

  // A guest's conversation must not reach the next guest on the same computer.
  // It did: owner() answered 'guest' for everyone signed out, so one identity
  // covered all of them and restore() handed the thread straight over.
  const guestPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // chat.js is the file under test here, so an exception thrown in it has to
  // count. Bound to `page` only, this check printed "clean" through one.
  guestPage.on('pageerror', e => problems.push('guest page error: ' + e.message));
  guestPage.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource|ERR_CONNECTION|net::/.test(text)) return;
    problems.push('guest console error: ' + text);
  });

  const secret = 'something a student would not want read';
  const THREAD = 'climby-chat-thread';
  const asGuest = async (p0) => {
    await p0.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await p0.waitForTimeout(1000);
    await p0.evaluate(() => {
      document.getElementById('entryGate')?.classList.add('hidden');
      document.getElementById('onboarding')?.classList.add('hidden');
      window.Auth.getToken = () => null;
      window.Auth.getUser = () => null;
      window.Auth.isLoggedIn = () => false;
      window.fetch = () => Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ answer: 'One step at a time.', suggestions: [] }),
      });
      // `?.` like the two lines above: without it a renamed FAB rejects the
      // evaluate, the top-level catch exits, and neither the browser nor the
      // port is ever closed.
      document.getElementById('aiFab')?.click();
    });
    await p0.waitForTimeout(250);
  };

  // Direction one: a guest must leave nothing for the next guest.
  await asGuest(guestPage);
  await guestPage.fill('#chatInput', secret);
  await guestPage.click('#chatSend');
  await guestPage.waitForTimeout(600);
  const leftBehind = await guestPage.evaluate(() => localStorage.getItem('climby-chat-thread'));
  if (leftBehind) problems.push('a guest conversation was written to localStorage');
  // the next student, same profile
  await asGuest(guestPage);
  await guestPage.waitForTimeout(300);
  if ((await guestPage.locator('#chatLog').innerText()).includes(secret)) {
    problems.push("a guest was shown the previous guest's conversation");
  }

  // Direction two: and must not take away what an ACCOUNT left.
  //
  // newPage() opens a fresh context, so the check above could only ever see
  // the guest's own write — it was structurally blind to the opposite fault,
  // which is the one the first fix introduced: persist() and restore() both
  // ran with no user while signing OUT, so they deleted the thread of the
  // account that had just left. Seeding the key first is what makes that
  // visible.
  const mine = JSON.stringify({ who: 'account-1', turns: [{ role: 'user', text: 'my own thread' }] });
  await guestPage.evaluate(([k, v]) => localStorage.setItem(k, v), [THREAD, mine]);
  await asGuest(guestPage);
  await guestPage.fill('#chatInput', 'a guest passing through');
  await guestPage.click('#chatSend');
  await guestPage.waitForTimeout(600);
  const survived = await guestPage.evaluate((k) => localStorage.getItem(k), THREAD);
  if (survived !== mine) {
    problems.push(`a guest session destroyed an account's stored thread (now ${survived})`);
  }
  if ((await guestPage.locator('#chatLog').innerText()).includes('my own thread')) {
    problems.push("a guest was shown an account's conversation");
  }

  await guestPage.close();

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
  await browser.close();
  server.close();

  if (problems.length) {
    console.log('PROBLEMS:\n' + problems.map(p => '  - ' + p).join('\n'));
    process.exit(1);
  }
  console.log(`page check clean: ${views.length} screens, ${wired.eyes} password fields`);
})().catch(err => { console.error(err); process.exit(1); });
