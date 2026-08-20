// theme.js — тема на приложението: авто (следва системата) / светла / тъмна.
// Пази избора в localStorage и за нов ученик по подразбиране е "авто". Стойността
// се прилага веднага при зареждане на скрипта (преди DOMContentLoaded), за да
// няма проблясък на грешна тема, и следи на живо системната тема, докато сме
// в режим "авто".
const Theme = (() => {
  // Един и същ ключ като преди — старите записани стойности 'light'/'dark' си
  // остават валидни (потребителят не бива да се "рестартира" на авто), просто
  // вече приемаме и трета стойност: 'auto'.
  const KEY = 'climby-theme';
  const MODES = ['auto', 'light', 'dark'];
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function systemTheme() {
    return media && media.matches ? 'dark' : 'light';
  }

  function getMode() {
    const saved = localStorage.getItem(KEY);
    return MODES.includes(saved) ? saved : 'auto';
  }

  function effectiveTheme(mode) {
    return mode === 'auto' ? systemTheme() : mode;
  }

  function applyDom(theme) {
    root.setAttribute('data-theme', theme);
  }

  // Синхронизира визуалното състояние на всеки 3-позиционен превключвател в
  // страницата (може да го има и в sidebar менюто, и в модала с настройки —
  // затова querySelectorAll, а не по id).
  function updateControls(mode) {
    document.querySelectorAll('[data-theme-mode]').forEach(btn => {
      const active = btn.getAttribute('data-theme-mode') === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  let lastApplied = null;

  function render(notify) {
    const mode = getMode();
    const theme = effectiveTheme(mode);
    applyDom(theme);
    updateControls(mode);
    if (notify && theme !== lastApplied) {
      lastApplied = theme;
      window.dispatchEvent(new CustomEvent('climby:theme-changed', { detail: { theme, mode } }));
    } else {
      lastApplied = theme;
    }
    return theme;
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) return;
    localStorage.setItem(KEY, mode);
    render(true);
  }

  function wireControls() {
    document.querySelectorAll('[data-theme-mode]').forEach(btn => {
      btn.addEventListener('click', () => setMode(btn.getAttribute('data-theme-mode')));
    });
  }

  // Приложи темата веднага, синхронно, при самото изпълнение на скрипта —
  // документният елемент вече съществува по това време, дори преди
  // DOMContentLoaded, така че няма проблясък на грешна тема.
  render(false);

  if (media) {
    media.addEventListener('change', () => {
      if (getMode() === 'auto') render(true);
    });
  }

  function init() {
    wireControls();
    render(true);
    window.addEventListener('climby:lang-changed', () => updateControls(getMode()));
  }

  return { init, setMode, getMode, getEffectiveTheme: () => effectiveTheme(getMode()) };
})();

document.addEventListener('DOMContentLoaded', Theme.init);
