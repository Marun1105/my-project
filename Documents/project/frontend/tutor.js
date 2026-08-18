// tutor.js — задава въпроса на сървъра, показва отговора на AI учителя (Markdown + LaTeX)
const Tutor = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  let scannedImages = []; // base64 (без "data:image/jpeg;base64," префикса), една или няколко страници

  function revealQuestionBox(dataUrls) {
    scannedImages = dataUrls.map(u => u.split(',')[1]);
    $('qa').classList.remove('hidden');
    $('question').focus();
    $('question').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderAnswer(text) {
    const el = $('answer');
    el.classList.remove('error');
    // Без DOMPurify не пускаме HTML изобщо — AI отговорът не е доверен вход.
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
  }

  function showError(text) {
    const el = $('answer');
    el.classList.remove('thinking');
    el.classList.add('error');
    el.textContent = text;
  }

  async function ask() {
    const question = $('question').value.trim();
    if (!question || !scannedImages.length) return;

    const answerEl = $('answer');
    answerEl.classList.remove('hidden', 'error');
    answerEl.classList.add('thinking');
    answerEl.innerHTML = '<span class="spark-spin">✨</span> ' + t('scanner.thinking');

    try {
      // Въпросът минава и без вход — затова токенът се праща само ако го има.
      // Без него сървърът не знае чий е въпросът и не го записва в историята.
      const token = Auth.getToken();
      const res = await Net.fetch(BACKEND + '/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ images: scannedImages, question, lang: I18n.get() }),
      });
      const data = await res.json().catch(() => ({}));
      answerEl.classList.remove('thinking');
      if (!res.ok) {
        // сървърът праща разбираем текст (лимит, грешка от AI и т.н.) в data.detail — показваме него, ако го има
        showError(typeof data.detail === 'string' && data.detail ? data.detail : t('scanner.errOffline'));
        return;
      }
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
    window.addEventListener('climby:scan-ready', e => revealQuestionBox(e.detail.dataUrls));
    $('askBtn').addEventListener('click', ask);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Tutor.init);
