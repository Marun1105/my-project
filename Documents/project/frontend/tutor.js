// tutor.js — задава въпроса на сървъра, показва отговора на AI учителя (Markdown + LaTeX)
const Tutor = (() => {
  const $ = id => document.getElementById(id);
  // Адресът на бекенда. Локално смени с http://127.0.0.1:8000
  const BACKEND = 'https://my-project-0gyk.onrender.com';
  let scannedBase64 = null;

  function revealQuestionBox(dataUrl) {
    scannedBase64 = dataUrl.split(',')[1]; // маха "data:image/jpeg;base64," префикса
    $('qa').classList.remove('hidden');
    $('question').focus();
  }

  function renderAnswer(text) {
    const el = $('answer');
    el.classList.remove('error');
    el.innerHTML = window.marked ? marked.parse(text) : text;
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

  function showError(text) {
    const el = $('answer');
    el.classList.remove('thinking');
    el.classList.add('error');
    el.textContent = text;
  }

  async function ask() {
    const question = $('question').value.trim();
    if (!question || !scannedBase64) return;

    const answerEl = $('answer');
    answerEl.classList.remove('hidden', 'error');
    answerEl.classList.add('thinking');
    answerEl.textContent = t('scanner.thinking');

    try {
      const res = await fetch(BACKEND + '/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: scannedBase64, question, lang: I18n.get() }),
      });
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      answerEl.classList.remove('thinking');
      if (data.answer) {
        renderAnswer(data.answer);
      } else {
        showError(t('scanner.errNoAnswer'));
      }
    } catch (err) {
      showError(t('scanner.errOffline'));
    }
  }

  function init() {
    window.addEventListener('climby:scan-ready', e => revealQuestionBox(e.detail.dataUrl));
    $('askBtn').addEventListener('click', ask);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Tutor.init);
