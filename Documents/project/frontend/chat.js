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
  const owner = () => {
    const u = window.Auth && Auth.getUser();
    return (u && u.id) ? String(u.id) : 'guest';
  };

  function persist() {
    try { localStorage.setItem(THREAD_KEY, JSON.stringify({ who: owner(), turns: history.slice(-THREAD_MAX) })); } catch {}
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(THREAD_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.who !== owner() || !Array.isArray(saved.turns) || !saved.turns.length) return;
    history = saved.turns.slice(-THREAD_MAX);
    $('chatEmpty').classList.add('hidden');
    for (const turn of history) {
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
  let busy = false;
  let open = false;

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
    box.value = '';
    window.dispatchEvent(new CustomEvent('climby:chat-sent'));
    $('chatEmpty').classList.add('hidden');
    const mine = bubble('user');
    mine.textContent = text;
    const theirs = bubble('ai');
    theirs.classList.add('chat-thinking');
    theirs.innerHTML = sparkSvg('spark-spin') + ' ' + t('scanner.thinking');
    scrollToEnd();
    busy = true;
    try {
      const token = window.Auth ? Auth.getToken() : null;
      const res = await Net.fetch(BACKEND + '/ask', {
        timeout: Net.AI_TIMEOUT_MS,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        // context: the tutor is told what is on the Route and what was asked
        // recently, so "what should I start with?" means something. Signed-in
        // only; the server ignores it for guests.
        body: JSON.stringify({ images: [], question: text, lang: I18n.get(), history,
                               mode: window.Prefs ? Prefs.get('tutor') : 'hints',
                               context: !!token, surface: 'chat' }),
      });
      const data = await res.json().catch(() => ({}));
      theirs.classList.remove('chat-thinking');
      if (!res.ok || !data.answer) {
        theirs.classList.add('chat-error');
        theirs.textContent = typeof data.detail === 'string' && data.detail ? data.detail : t('scanner.errOffline');
        return;
      }
      render(data.answer, theirs);
      if (window.Speak) Speak.attach(theirs);
      if (window.Copy) Copy.attach(theirs);
      window.dispatchEvent(new CustomEvent('climby:activity'));
      history.push({ role: 'user', text }, { role: 'assistant', text: data.answer });
      persist();
    } catch (err) {
      theirs.classList.remove('chat-thinking');
      theirs.classList.add('chat-error');
      theirs.textContent = t('scanner.errOffline');
    } finally {
      busy = false;
      scrollToEnd();
      box.focus();
    }
  }

  // Empty the panel without touching what is stored. Signing in and out swaps
  // whose thread is on screen; only the "new chat" button throws one away.
  function clearView() {
    history = [];
    $('chatLog').innerHTML = '';
    $('chatEmpty').classList.remove('hidden');
    if (window.Speak) Speak.stop();
  }

  function reset() {
    try { localStorage.removeItem(THREAD_KEY); } catch {}
    clearView();
  }

  function setOpen(next) {
    open = next;
    $('chatPanel').classList.toggle('hidden', !open);
    $('aiFab').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('aiFab').classList.toggle('is-open', open);
    if (open) setTimeout(() => $('chatInput').focus(), 50);
    else if (window.Speak) Speak.stop();
  }

  function init() {
    const fab = $('aiFab');
    if (!fab || !$('chatPanel')) return;
    fab.addEventListener('click', () => setOpen(!open));
    $('chatClose').addEventListener('click', () => setOpen(false));
    $('chatNew').addEventListener('click', reset);
    $('chatSend').addEventListener('click', send);
    // What the tutor can see is stated, not hidden. Both the line and the
    // starter that relies on it appear only when there is an account to see.
    const syncContext = () => {
      const on = !!(window.Auth && Auth.isLoggedIn());
      const sees = document.getElementById('chatSees');
      const route = document.getElementById('chatStarterRoute');
      if (sees) sees.classList.toggle('hidden', !on);
      if (route) route.classList.toggle('hidden', !on);
    };
    syncContext();
    window.addEventListener('climby:auth-changed', () => {
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

  return { open: () => setOpen(true), close: () => setOpen(false), reset };
})();

window.Chat = Chat;
