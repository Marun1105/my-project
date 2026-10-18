// chat.js — ClimbAI as a chat you can open from anywhere.
//
// The corner circle opens a panel over whatever screen you are on: ask a
// question, get an answer, reply, close it, carry on. No photograph needed —
// this is the tutor for "what is a prime number", not for "check problem 7 on
// this page"; that one lives on the ClimbAI screen with the camera.
//
// Same backend, same conversation shape, same teaching rules. The thread stays
// while the panel is closed and reopened; "new chat" starts over.
const Chat = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  let history = [];
  // The thread used to live only in memory: close the app mid-conversation and
  // it was gone, the way no messaging app loses a conversation. The last one is
  // kept on this device (not the account — it is a scratchpad, not history;
  // Summited has the questions and answers properly) and put back on open.
  const THREAD_KEY = 'climby-chat-thread';
  const THREAD_MAX = 12;   // the same cap the server accepts per request

  // Whose thread it is. A school computer has more than one student on it, and
  // a conversation left on screen for the next one is the wrong kind of memory.
  //
  // A guest is nobody in particular, so there is no "whose" to record. Writing
  // one down under the name 'guest' - which is what this used to do - gave every
  // guest on the machine the same identity, and handed the next one the last
  // one's conversation. That is the precise thing the line above promises not to
  // do, and it was prevented only for accounts. So for a guest nothing is
  // stored: the thread lives as long as the tab. Losing it on reload is the
  // price, and it is not a close call.
  const owner = () => {
    const u = window.Auth && Auth.getUser();
    return (u && u.id) ? String(u.id) : null;
  };

  // Many chats, not one. Each is kept on this device per account, newest
  // first, so a conversation can be opened again later — from the list in this
  // panel or from Done & dusted. "New chat" puts the current one away instead
  // of throwing it out; only its own ✕ deletes a chat.
  const CHATS_PREFIX = 'climby-chats-v1:';
  const CHATS_MAX = 30;      // chats kept
  const TURNS_KEEP = 60;     // turns kept per chat (the server still gets the last THREAD_MAX)
  let currentId = null;
  let shownFor = null;       // whose chats the panel was last filled from

  // A deliberate "Log out" click means the computer is being handed over — in
  // a school that is the whole point of the button — so that account's chats
  // leave the device with them (every question stays in the account, under
  // Done & dusted). A silent 401 expiry does not: they are still sitting
  // there. Called only from the auth handler, for the click.
  function forgetThread(who) {
    if (!who) return;
    try {
      localStorage.removeItem(CHATS_PREFIX + who);
      localStorage.removeItem(THREAD_KEY);
    } catch { /* nothing kept, nothing to remove */ }
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function titleOf(turns) {
    const first = (turns.find(x => x.role === 'user') || {}).text || '';
    const line = first.replace(/\s+/g, ' ').trim();
    return line.length > 70 ? line.slice(0, 68) + '…' : line;
  }

  function load() {
    const who = owner();
    if (!who) return null;             // a guest leaves nothing behind
    let s = null;
    try { s = JSON.parse(localStorage.getItem(CHATS_PREFIX + who) || 'null'); } catch { s = null; }
    if (!s || !Array.isArray(s.chats)) s = { current: null, chats: [] };
    // the single thread kept before there were many chats becomes the first one
    try {
      const old = JSON.parse(localStorage.getItem(THREAD_KEY) || 'null');
      if (old && old.who === who && Array.isArray(old.turns) && old.turns.length) {
        const id = newId();
        s.chats.unshift({ id, title: titleOf(old.turns), updated: Date.now(), turns: old.turns });
        s.current = id;
        localStorage.removeItem(THREAD_KEY);
        localStorage.setItem(CHATS_PREFIX + who, JSON.stringify(s));
      }
    } catch { /* the old thread stays where it was */ }
    return s;
  }

  function store(s) {
    const who = owner();
    if (!who) return;
    try { localStorage.setItem(CHATS_PREFIX + who, JSON.stringify(s)); } catch { /* lasts this visit */ }
    window.dispatchEvent(new CustomEvent('climby:chats-changed'));
  }

  function list() {
    const s = load();
    return s ? s.chats.map(c => ({ id: c.id, title: c.title, updated: c.updated, turns: c.turns.length })) : [];
  }

  // Neither of these deletes. A guest writing nothing is what stops the leak;
  // signing out empties the view but keeps the account's chats for its return.
  function persist() {
    const s = load();
    if (!s || !history.length) return;
    let chat = currentId && s.chats.find(c => c.id === currentId);
    if (!chat) {
      currentId = newId();
      chat = { id: currentId, title: titleOf(history), updated: Date.now(), turns: [] };
    } else {
      s.chats = s.chats.filter(c => c !== chat);
    }
    chat.turns = history.slice(-TURNS_KEEP);
    chat.updated = Date.now();
    if (!chat.title) chat.title = titleOf(history);
    s.chats.unshift(chat);
    s.chats = s.chats.slice(0, CHATS_MAX);
    s.current = currentId;
    store(s);
  }

  function draw(turns) {
    $('chatEmpty').classList.toggle('hidden', !!turns.length);
    for (const turn of turns) {
      const el = bubble(turn.role === 'user' ? 'user' : 'ai');
      if (turn.role === 'user') el.textContent = turn.text;
      else {
        render(turn.text, el);
        if (window.Speak) Speak.attach(el);
        if (window.Copy) Copy.attach(el);
      }
    }
    scrollToEnd();
  }

  function restore() {
    shownFor = owner();
    const s = load();
    if (!s || !s.current) return;
    const chat = s.chats.find(c => c.id === s.current);
    if (!chat || !chat.turns.length) return;
    currentId = chat.id;
    history = chat.turns.slice();
    draw(history);
  }

  // Open a saved chat in the panel.
  function openThread(id) {
    const s = load();
    const chat = s && s.chats.find(c => c.id === id);
    if (!chat) return false;
    clearView();
    currentId = chat.id;
    history = chat.turns.slice();
    s.current = chat.id;
    store(s);
    showThreads(false);
    if (!open) setOpen(true);
    draw(history);
    return true;
  }

  // Carry on from an earlier question and answer (Done & dusted).
  function startFrom(turns) {
    clearView();
    history = turns.filter(x => x && x.text).map(x => ({ role: x.role, text: String(x.text).slice(0, 4000) }));
    persist();
    showThreads(false);
    if (!open) setOpen(true);
    draw(history);
  }

  function removeThread(id) {
    const s = load();
    if (!s) return;
    s.chats = s.chats.filter(c => c.id !== id);
    if (s.current === id) s.current = null;
    store(s);
    if (currentId === id) clearView();
    renderThreads();
  }

  // ---- the list of chats, inside the panel --------------------------------
  function ago(ms) {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return t('chat.agoNow');
    if (mins < 60) return t('chat.agoMin', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('chat.agoHour', { n: hours });
    return new Date(ms).toLocaleDateString(window.I18n && I18n.get() === 'bg' ? 'bg-BG' : 'en-GB', { day: 'numeric', month: 'short' });
  }

  function renderThreads() {
    const box = $('chatThreadList');
    if (!box) return;
    box.textContent = '';
    if (!owner()) {
      const p = document.createElement('p');
      p.className = 'chat-threads-empty';
      p.textContent = t('chat.threadsGuest');
      box.appendChild(p);
      return;
    }
    const chats = list();
    if (!chats.length) {
      const p = document.createElement('p');
      p.className = 'chat-threads-empty';
      p.textContent = t('chat.threadsEmpty');
      box.appendChild(p);
      return;
    }
    for (const c of chats) {
      const row = document.createElement('div');
      row.className = 'chat-thread' + (c.id === currentId ? ' is-current' : '');
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'chat-thread-open';
      const title = document.createElement('span');
      title.className = 'chat-thread-title';
      title.textContent = c.title || t('chat.untitled');
      const meta = document.createElement('span');
      meta.className = 'chat-thread-meta';
      meta.textContent = ago(c.updated);
      openBtn.append(title, meta);
      openBtn.addEventListener('click', () => openThread(c.id));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chat-thread-del';
      del.setAttribute('aria-label', t('chat.deleteChat'));
      del.textContent = '✕';
      del.addEventListener('click', () => removeThread(c.id));
      row.append(openBtn, del);
      box.appendChild(row);
    }
  }

  function showThreads(show) {
    const panel = $('chatThreads');
    if (!panel) return;
    panel.classList.toggle('hidden', !show);
    $('chatThreadsBtn').setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) renderThreads();
  }

  let busy = false;
  let open = false;
  // Bumped whenever the thread on screen is swapped or thrown away. An answer
  // that arrives after that belongs to a conversation that is gone — on a
  // shared computer, to the previous student — and must not be written into
  // the new one.
  let epoch = 0;

  function t(key, vars) { return window.t ? window.t(key, vars) : key; }

  function render(text, el) {
    if (window.marked && window.DOMPurify) {
      el.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else {
      el.textContent = text;
    }
    if (window.renderMathInElement) {
      renderMathInElement(el, {
        delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
        throwOnError: false,
      });
    }
  }

  function bubble(role) {
    const b = document.createElement('div');
    b.className = 'chat-msg ' + (role === 'user' ? 'chat-user' : 'chat-ai');
    $('chatLog').appendChild(b);
    return b;
  }

  function scrollToEnd() {
    const log = $('chatLog');
    log.scrollTop = log.scrollHeight;
  }

  async function send() {
    const box = $('chatInput');
    const text = box.value.trim();
    if (!text || busy) return;

    // An offer is on screen and the reply is "yes". That is an answer to the
    // button, not a question for the tutor: it is matched here and costs no
    // call. Anything else goes to the tutor as usual and the card stays up.
    if (window.Suggest && Suggest.hasPending() && Suggest.looksLikeYes(text)) {
      box.value = '';
      window.dispatchEvent(new CustomEvent('climby:chat-sent'));
      $('chatEmpty').classList.add('hidden');
      const mineYes = bubble('user');
      mineYes.textContent = text;
      const n = await Suggest.acceptPending();
      const note = bubble('ai');
      note.textContent = n
        ? t(n === 1 ? 'suggest.confirmOne' : 'suggest.confirmMany', { n })
        : t('suggest.failed');
      scrollToEnd();
      box.focus();
      return;
    }
    box.value = '';
    window.dispatchEvent(new CustomEvent('climby:chat-sent'));
    $('chatEmpty').classList.add('hidden');
    const mine = bubble('user');
    mine.textContent = text;
    const theirs = bubble('ai');
    theirs.classList.add('chat-thinking');
    theirs.appendChild(AIActivity.create('thinking', t('scanner.thinking'), true, { phases: 'chat' }));
    const aside = document.createElement('span');
    aside.className = 'thinking-quip';
    aside.setAttribute('aria-hidden', 'true');
    aside.textContent = I18n.loadingAside();
    theirs.appendChild(aside);
    scrollToEnd();
    busy = true;
    const asked = epoch;
    try {
      const token = window.Auth ? Auth.getToken() : null;
      const res = await Net.fetch(BACKEND + '/ask', {
        timeout: Net.AI_TIMEOUT_MS,
        loadingKey: 'loading.ai',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ images: [], question: text, lang: I18n.get(), history: history.slice(-THREAD_MAX),
                               mode: window.Prefs ? Prefs.get('tutor') : 'hints',
                               context: false,
                               memory: token && window.Memory ? Memory.request() : null,
                               surface: 'chat' }),
      });
      const data = await res.json().catch(() => ({}));
      if (asked !== epoch) return;
      theirs.classList.remove('chat-thinking');
      if (!res.ok || !data.answer) {
        theirs.classList.add('chat-error');
        theirs.textContent = typeof data.detail === 'string' && data.detail ? data.detail : t('scanner.errOffline');
        return;
      }
      const took = AIActivity.seconds(theirs);
      render(data.answer, theirs);
      AIActivity.sign(theirs, took);
      if (window.Speak) Speak.attach(theirs);
      if (window.Copy) Copy.attach(theirs);
      // Homework the tutor heard in the message, offered as a card with one
      // button. Nothing reaches the Route until it is pressed.
      if (window.Suggest) Suggest.render([...(data.suggestions || []), ...(data.plan || [])], theirs);
      if (window.Smart) Smart.render(data, theirs);
      window.dispatchEvent(new CustomEvent('climby:activity'));
      history.push({ role: 'user', text }, { role: 'assistant', text: data.answer });
      persist();
    } catch (err) {
      if (asked !== epoch) return;
      theirs.classList.remove('chat-thinking');
      theirs.classList.add('chat-error');
      theirs.textContent = t('scanner.errOffline');
    } finally {
      // A stale request leaves the busy flag alone: it may already belong to a
      // question asked in the new thread.
      if (asked === epoch) {
        busy = false;
        scrollToEnd();
        box.focus();
      }
    }
  }

  // Empty the panel without touching what is stored. Signing in and out swaps
  // whose thread is on screen; only the "new chat" button throws one away.
  function clearView() {
    epoch++;
    busy = false;
    history = [];
    currentId = null;
    if (window.Suggest) Suggest.clearPending();
    $('chatLog').innerHTML = '';
    $('chatEmpty').classList.remove('hidden');
    if (window.Speak) Speak.stop();
  }

  // "New chat": the one on screen is already saved; start a fresh one.
  function reset() {
    clearView();
    const s = load();
    if (s) { s.current = null; store(s); }
    showThreads(false);
    $('chatInput').focus();
  }

  function setOpen(next) {
    open = next;
    $('chatPanel').classList.toggle('hidden', !open);
    $('aiFab').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('aiFab').classList.toggle('is-open', open);
    if (open) { setTimeout(() => $('chatInput').focus(), 50); syncExpand(); }
    else if (window.Speak) Speak.stop();
  }

  // ---- size: drag the top-left corner, or the expand button --------------
  // Kept per device. A phone shows the chat full screen, so none of this
  // applies under 700px.
  const SIZE_KEY = 'climby-chat-size';
  const MIN_W = 340, MIN_H = 380;
  const wide = () => window.innerWidth >= 700;
  const maxW = () => window.innerWidth - 44;
  const maxH = () => window.innerHeight - 114;

  function applySize(w, h) {
    const panel = $('chatPanel');
    if (!w || !h || !wide()) { panel.style.width = ''; panel.style.height = ''; return; }
    panel.style.width = Math.round(Math.min(maxW(), Math.max(MIN_W, w))) + 'px';
    panel.style.height = Math.round(Math.min(maxH(), Math.max(MIN_H, h))) + 'px';
  }

  function savedSize() {
    try { return JSON.parse(localStorage.getItem(SIZE_KEY) || 'null'); } catch { return null; }
  }

  function saveSize(size) {
    try {
      if (size) localStorage.setItem(SIZE_KEY, JSON.stringify(size));
      else localStorage.removeItem(SIZE_KEY);
    } catch { /* the size lasts for this visit */ }
  }

  function syncExpand() {
    const panel = $('chatPanel');
    const big = !!panel.style.width && panel.offsetWidth >= maxW() - 4 && panel.offsetHeight >= maxH() - 4;
    $('chatExpand').setAttribute('aria-pressed', big ? 'true' : 'false');
    $('chatExpand').classList.toggle('is-big', big);
  }

  function initResize() {
    const panel = $('chatPanel');
    const grip = $('chatGrip');
    if (!grip) return;
    const s = savedSize();
    if (s) applySize(s.w, s.h);
    let drag = null;
    grip.addEventListener('pointerdown', e => {
      if (!wide()) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
      grip.setPointerCapture(e.pointerId);
      panel.classList.add('is-resizing');
    });
    grip.addEventListener('pointermove', e => {
      if (!drag) return;
      // anchored bottom-right: dragging up and left makes it bigger
      applySize(drag.w + (drag.x - e.clientX), drag.h + (drag.y - e.clientY));
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      panel.classList.remove('is-resizing');
      saveSize({ w: panel.offsetWidth, h: panel.offsetHeight });
      syncExpand();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', () => { applySize(0, 0); saveSize(null); syncExpand(); });
    // the keyboard can resize too: arrows grow and shrink by 40px
    grip.addEventListener('keydown', e => {
      const step = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
      if (!step) return;
      e.preventDefault();
      applySize(panel.offsetWidth + step[0], panel.offsetHeight + step[1]);
      saveSize({ w: panel.offsetWidth, h: panel.offsetHeight });
      syncExpand();
    });
    $('chatExpand').addEventListener('click', () => {
      const big = $('chatExpand').getAttribute('aria-pressed') === 'true';
      if (big) { applySize(0, 0); saveSize(null); }
      else { applySize(maxW(), maxH()); saveSize({ w: maxW(), h: maxH() }); }
      syncExpand();
    });
    window.addEventListener('resize', () => {
      const now = savedSize();
      applySize(now && now.w, now && now.h);
    });
  }

  function init() {
    const fab = $('aiFab');
    if (!fab || !$('chatPanel')) return;
    fab.addEventListener('click', () => setOpen(!open));
    $('chatClose').addEventListener('click', () => setOpen(false));
    $('chatNew').addEventListener('click', reset);
    $('chatThreadsBtn').addEventListener('click', () => showThreads($('chatThreads').classList.contains('hidden')));
    window.addEventListener('climby:lang-changed', renderThreads);
    initResize();
    $('chatSend').addEventListener('click', send);
    $('chatMemoryManage').addEventListener('click', () => {
      if (window.AccountUI) AccountUI.open('setMemory');
    });
    // What the tutor can see is stated, not hidden. Both the line and the
    // starter that relies on it appear only when there is an account to see.
    const syncContext = () => {
      const on = !!(window.Auth && Auth.isLoggedIn());
      const sees = document.getElementById('chatSees');
      const route = document.getElementById('chatStarterRoute');
      const selected = on && window.Memory ? Memory.request() : null;
      if (sees) sees.classList.toggle('hidden', !(selected && Memory.isEnabled()));
      if (route) route.classList.toggle('hidden', !(selected && selected.checklist));
    };
    syncContext();
    if (window.Memory) Memory.render();
    window.addEventListener('climby:memory-changed', syncContext);
    window.addEventListener('climby:auth-changed', (e) => {
      if (e && e.detail && e.detail.showGate) forgetThread(shownFor);
      syncContext();
      clearView();
      restore();
    });
    document.querySelectorAll('.chat-starter').forEach(btn => {
      btn.addEventListener('click', () => {
        $('chatInput').value = btn.textContent;
        send();
      });
    });
    restore();
    // A one-line box for a five-line question hides everything but the last
    // line while it is being written. It grows now, up to a point.
    const box = $('chatInput');
    const grow = () => {
      box.style.height = 'auto';
      box.style.height = Math.min(box.scrollHeight, 160) + 'px';
    };
    box.addEventListener('input', grow);
    window.addEventListener('climby:chat-sent', grow);
    grow();
    $('chatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) setOpen(false); });
    // Starting a focus session hides the circle; the panel goes with it.
    window.addEventListener('climby:focus-live', () => { if (document.body.classList.contains('focus-live')) setOpen(false); });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { open: () => setOpen(true), close: () => setOpen(false), reset, list, openThread, startFrom };
})();

window.Chat = Chat;
