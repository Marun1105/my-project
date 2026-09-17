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
        body: JSON.stringify({ images: [], question: text, lang: I18n.get(), history,
                               mode: window.Prefs ? Prefs.get('tutor') : 'hints' }),
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
      history.push({ role: 'user', text }, { role: 'assistant', text: data.answer });
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

  function reset() {
    history = [];
    $('chatLog').innerHTML = '';
    $('chatEmpty').classList.remove('hidden');
    if (window.Speak) Speak.stop();
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
