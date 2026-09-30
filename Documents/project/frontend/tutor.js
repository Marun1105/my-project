// tutor.js — the conversation with the AI tutor: the photographed pages are the
// context, the student asks, the tutor answers, the student replies, and so on.
//
// It was a single question and a single answer. Every method the research
// points to — hold the solution back, ask one guiding question, make the
// student explain — assumes the student can answer. A question nobody can reply
// to is rhetoric. So the answer card became a thread with a reply box under it.
//
// The first question about a page is different from the rest. The server has
// the stronger model read the photographs once and keeps what it read; every
// reply after that names the page by id instead of uploading it again. That
// first answer takes about half a minute, so it gets its own waiting state, and
// what was read is shown folded above the answer so a misread number can be
// caught before the explanation built on it is believed.
const Tutor = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  let scannedImages = []; // base64 (без "data:image/jpeg;base64," префикса), една или няколко страници
  // The conversation so far, as the server wants it: {role, text}, in order.
  // Cleared when new pages are photographed — a new page is a new conversation.
  let history = [];
  let busy = false;
  // The page as the server read it. Null when the read failed (or the server is
  // older than the relay): then the photographs go with every turn, as before.
  let briefId = null;
  // The staged "reading your page" steps run on timers; this cancels them.
  let stopSteps = null;

  function revealQuestionBox(dataUrls) {
    scannedImages = dataUrls.map(u => u.split(',')[1]);
    resetThread();
    $('qa').classList.remove('hidden');
    $('question').focus();
    $('question').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetThread() {
    history = [];
    briefId = null;
    hideRead();
    $('answer').classList.add('hidden');
    $('answer').innerHTML = '';
    $('thread').innerHTML = '';
    $('followUp').classList.add('hidden');
    if (window.Speak) Speak.stop();
  }

  // Markdown + LaTeX into `el`, after `prefix`. The AI's text is untrusted:
  // no DOMPurify, no HTML.
  function renderMarkdown(text, el, prefix = '') {
    if (window.marked && window.DOMPurify) {
      el.innerHTML = prefix + DOMPurify.sanitize(marked.parse(text));
    } else {
      el.innerHTML = prefix;
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
  }

  function renderAnswer(text, el) {
    el.classList.remove('error');
    renderMarkdown(text, el, window.aiBadgeHtml());
    // The speaker goes on after the maths is rendered, so what it reads is
    // what is on screen — and it removes anything still speaking.
    if (window.Speak) Speak.attach(el);
    if (window.Copy) Copy.attach(el);
  }

  // What the stronger model read off the photographs, folded shut above the
  // first answer. Never the worked solution: that stays on the server.
  function showRead(text) {
    const panel = $('readPanel');
    if (!panel) return;
    renderMarkdown(text, panel.querySelector('.read-body'));
    panel.open = false;
    panel.classList.remove('hidden');
  }

  function hideRead() {
    const panel = $('readPanel');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.open = false;
    panel.querySelector('.read-body').innerHTML = '';
  }

  function clearSteps() {
    if (stopSteps) stopSteps();
    stopSteps = null;
  }

  function showError(el, text) {
    clearSteps();
    el.classList.remove('thinking', 'reading');
    el.classList.add('error');
    el.textContent = text;
  }

  function showThinking(el) {
    clearSteps();
    el.classList.remove('hidden', 'error', 'reading');
    el.classList.add('thinking');
    el.innerHTML = sparkSvg('spark-spin') + ' ' + t('scanner.thinking');
  }

  // Half a minute of "Thinking…" looks frozen. The server does not report
  // progress, so the steps advance on the times that were measured (reading
  // about 20 s, solving about 15 s) and the last one holds until the answer
  // arrives — it never claims to be finished.
  const STEPS = [
    { key: 'scanner.stepRead', at: 0 },
    { key: 'scanner.stepSolve', at: 18000 },
    { key: 'scanner.stepWrite', at: 34000 },
  ];

  function showReading(el) {
    clearSteps();
    el.classList.remove('hidden', 'error');
    el.classList.add('thinking', 'reading');
    el.innerHTML = '';
    const list = document.createElement('ol');
    list.className = 'read-steps';
    const items = STEPS.map(step => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'read-step-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = t(step.key);
      li.append(dot, label);
      list.appendChild(li);
      return li;
    });
    const note = document.createElement('p');
    note.className = 'read-note';
    note.textContent = t('scanner.readingNote');
    el.append(list, note);

    const mark = i => items.forEach((li, j) => {
      li.classList.toggle('done', j < i);
      li.classList.toggle('active', j === i);
    });
    mark(0);
    const timers = STEPS.slice(1).map((step, i) => setTimeout(() => mark(i + 1), step.at));
    stopSteps = () => timers.forEach(clearTimeout);
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

  // withPages: send the photographs (the first question, or no brief to name).
  function post(question, withPages) {
    // Въпросът минава и без вход — затова токенът се праща само ако го има.
    // Без него сървърът не знае чий е въпросът и не го записва в историята.
    const token = Auth.getToken();
    const reading = withPages && !history.length;
    return Net.fetch(BACKEND + '/ask', {
      // Тук отиват снимани страници и се чака дълго обяснение. Първият въпрос
      // чака и прочитането на страницата, затова срокът му е по-дълъг.
      timeout: reading ? Net.AI_READ_TIMEOUT_MS : Net.AI_TIMEOUT_MS,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        images: withPages ? scannedImages : [],
        brief_id: withPages ? null : briefId,
        question, lang: I18n.get(), history,
        mode: window.Prefs ? Prefs.get('tutor') : 'hints',
        surface: 'tutor',
      }),
    });
  }

  async function send(question, target) {
    busy = true;
    const first = !history.length;
    if (first) showReading(target); else showThinking(target);
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      let res = await post(question, first || !briefId);
      // 410: the server no longer has the page it read. The photographs are
      // still here — send them instead, once, and carry on without a brief.
      if (res.status === 410 && !first) {
        briefId = null;
        res = await post(question, true);
      }
      const data = await res.json().catch(() => ({}));
      clearSteps();
      target.classList.remove('thinking', 'reading');
      if (!res.ok) {
        // сървърът праща разбираем текст (лимит, грешка от AI и т.н.) в data.detail — показваме него, ако го има
        showError(target, typeof data.detail === 'string' && data.detail ? data.detail : t('scanner.errOffline'));
        return false;
      }
      if (!data.answer) {
        showError(target, t('scanner.errNoAnswer'));
        return false;
      }
      if (first) {
        briefId = data.brief_id || null;
        if (data.read) showRead(data.read);
      }
      window.dispatchEvent(new CustomEvent('climby:activity'));
      renderAnswer(data.answer, target);
      history.push({ role: 'user', text: question }, { role: 'assistant', text: data.answer });
      $('followUp').classList.remove('hidden');
      return true;
    } catch (err) {
      // An abort is the time limit, not the network: "check your internet" to
      // someone whose internet is fine sends them looking in the wrong place.
      showError(target, t(err && err.name === 'AbortError' ? 'scanner.errSlow' : 'scanner.errOffline'));
      return false;
    } finally {
      clearSteps();
      busy = false;
    }
  }

  async function ask() {
    const question = $('question').value.trim();
    if (!question || !scannedImages.length || busy) return;
    // The first question starts the conversation over: the pages are the same,
    // but a new opening question is a new thread — and it is read again, since
    // the reading is scoped to the problem asked about.
    history = [];
    briefId = null;
    hideRead();
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
    // Quick questions fill the box; the person can still edit before sending.
    document.querySelectorAll('.quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const box = $('question');
        box.value = t(btn.dataset.quick);
        box.focus();
        if (btn.dataset.quickFocus) { box.setSelectionRange(box.value.length, box.value.length); return; }
        Net.guardClick($('askBtn'), ask);
      });
    });
    $('question').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Net.guardClick($('askBtn'), ask); }
    });
    $('followBtn').addEventListener('click', () => Net.guardClick($('followBtn'), followUp));
    // Enter sends, Shift+Enter is a new line — the way every chat works.
    $('followQuestion').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Net.guardClick($('followBtn'), followUp); }
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Tutor.init);
