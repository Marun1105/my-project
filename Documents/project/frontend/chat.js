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

  function forgetThread() {
    try { localStorage.removeItem(THREAD_KEY); } catch {}
  }

  // Neither of these deletes. A guest writing nothing is what stops the leak;
  // deleting as well looked like belt and braces and was data loss, because
  // both run with no user on the way OUT of an account: the auth-changed
  // handler is `clearView(); restore();`, so signing out — or a token quietly
  // expiring into logout(false) — reached forgetThread() and threw away the
  // conversation of the account that had just left. It was gone on signing
  // back in. Only the "new chat" button throws a thread away.
  function persist() {
    const who = owner();
    if (!who) return;                  // a guest leaves nothing behind
    try { localStorage.setItem(THREAD_KEY, JSON.stringify({ who, turns: history.slice(-THREAD_MAX) })); } catch {}
  }

  function restore() {
    const who = owner();
    if (!who) return;                  // and is handed nothing either
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(THREAD_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.who !== who || !Array.isArray(saved.turns) || !saved.turns.length) return;
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
    theirs.innerHTML = sparkSvg('spark-spin') + ' ' + t('scanner.thinking');
    scrollToEnd();
    busy = true;
    const asked = epoch;
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
      if (asked !== epoch) return;
      theirs.classList.remove('chat-thinking');
      if (!res.ok || !data.answer) {
        theirs.classList.add('chat-error');
        theirs.textContent = typeof data.detail === 'string' && data.detail ? data.detail : t('scanner.errOffline');
        return;
      }
      render(data.answer, theirs);
      if (window.Speak) Speak.attach(theirs);
      if (window.Copy) Copy.attach(theirs);
      // Homework the tutor heard in the message, offered as a card with one
      // button. Nothing reaches the Route until it is pressed.
      if (window.Suggest) Suggest.render(data.suggestions, theirs);
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
    if (window.Suggest) Suggest.clearPending();
    $('chatLog').innerHTML = '';
    $('chatEmpty').classList.remove('hidden');
    if (window.Speak) Speak.stop();
  }

  function reset() {
    forgetThread();
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
