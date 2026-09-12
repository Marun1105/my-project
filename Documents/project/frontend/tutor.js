// tutor.js — the conversation with the AI tutor: the photographed pages are the
// context, the student asks, the tutor answers, the student replies, and so on.
//
// It was a single question and a single answer. Every method the research
// points to — hold the solution back, ask one guiding question, make the
// student explain — assumes the student can answer. A question nobody can reply
// to is rhetoric. So the answer card became a thread with a reply box under it.
const Tutor = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  let scannedImages = []; // base64 (без "data:image/jpeg;base64," префикса), една или няколко страници
  // The conversation so far, as the server wants it: {role, text}, in order.
  // Cleared when new pages are photographed — a new page is a new conversation.
  let history = [];
  let busy = false;

  function revealQuestionBox(dataUrls) {
    scannedImages = dataUrls.map(u => u.split(',')[1]);
    resetThread();
    $('qa').classList.remove('hidden');
    $('question').focus();
    $('question').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetThread() {
    history = [];
    $('answer').classList.add('hidden');
    $('answer').innerHTML = '';
    $('thread').innerHTML = '';
    $('followUp').classList.add('hidden');
    if (window.Speak) Speak.stop();
  }

  // Markdown + LaTeX into `el`. The AI's text is untrusted: no DOMPurify, no HTML.
  function renderAnswer(text, el) {
    el.classList.remove('error');
    if (window.marked && window.DOMPurify) {
      el.innerHTML = window.aiBadgeHtml() + DOMPurify.sanitize(marked.parse(text));
    } else {
      el.innerHTML = window.aiBadgeHtml();
      const plain = document.createElement('div');
      plain.textContent = text;
      el.appendChild(plain);
    }
    if (window.renderMathInElement) {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
      });
    }
    // The speaker goes on after the maths is rendered, so what it reads is
    // what is on screen — and it removes anything still speaking.
    if (window.Speak) Speak.attach(el);
  }

  function showError(el, text) {
    el.classList.remove('thinking');
    el.classList.add('error');
    el.textContent = text;
  }

  function showThinking(el) {
    el.classList.remove('hidden', 'error');
    el.classList.add('thinking');
    el.innerHTML = sparkSvg('spark-spin') + ' ' + t('scanner.thinking');
  }

  // A follow-up: the student's words as a small bubble, then a fresh answer card
  // under it. The first answer keeps the original #answer card, so nothing that
  // knew about it has to change.
  function appendUserTurn(text) {
    const b = document.createElement('div');
    b.className = 'turn-user';
    const who = document.createElement('span');
    who.className = 'turn-who';
    who.textContent = t('scanner.you');
    const body = document.createElement('p');
    body.textContent = text;
    b.append(who, body);
    $('thread').appendChild(b);
    return b;
  }

  function appendAnswerCard() {
    const c = document.createElement('div');
    c.className = 'card answer';
    c.setAttribute('role', 'status');
    c.setAttribute('aria-live', 'polite');
    $('thread').appendChild(c);
    return c;
  }

  async function send(question, target) {
    busy = true;
    showThinking(target);
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      // Въпросът минава и без вход — затова токенът се праща само ако го има.
      // Без него сървърът не знае чий е въпросът и не го записва в историята.
      const token = Auth.getToken();
      const res = await Net.fetch(BACKEND + '/ask', {
        // Тук отиват няколко снимани страници и се чака дълго обяснение — обичайният
        // кратък срок отрязваше отговора и ученикът получаваше "провери интернета си".
        timeout: Net.AI_TIMEOUT_MS,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ images: scannedImages, question, lang: I18n.get(), history }),
      });
      const data = await res.json().catch(() => ({}));
      target.classList.remove('thinking');
      if (!res.ok) {
        // сървърът праща разбираем текст (лимит, грешка от AI и т.н.) в data.detail — показваме него, ако го има
        showError(target, typeof data.detail === 'string' && data.detail ? data.detail : t('scanner.errOffline'));
        return false;
      }
      if (!data.answer) {
        showError(target, t('scanner.errNoAnswer'));
        return false;
      }
      renderAnswer(data.answer, target);
      history.push({ role: 'user', text: question }, { role: 'assistant', text: data.answer });
      $('followUp').classList.remove('hidden');
      return true;
    } catch (err) {
      showError(target, t('scanner.errOffline'));
      return false;
    } finally {
      busy = false;
    }
  }

  async function ask() {
    const question = $('question').value.trim();
    if (!question || !scannedImages.length || busy) return;
    // The first question starts the conversation over: the pages are the same,
    // but a new opening question is a new thread.
    history = [];
    $('thread').innerHTML = '';
    await send(question, $('answer'));
  }

  async function followUp() {
    const text = $('followQuestion').value.trim();
    if (!text || busy || !history.length) return;
    $('followQuestion').value = '';
    appendUserTurn(text);
    const ok = await send(text, appendAnswerCard());
    if (ok) $('followQuestion').focus();
  }

  function init() {
    window.addEventListener('climby:scan-ready', e => revealQuestionBox(e.detail.dataUrls));
    $('askBtn').addEventListener('click', () => Net.guardClick($('askBtn'), ask));
    $('followBtn').addEventListener('click', () => Net.guardClick($('followBtn'), followUp));
    // Enter sends, Shift+Enter is a new line — the way every chat works.
    $('followQuestion').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); followUp(); }
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Tutor.init);
