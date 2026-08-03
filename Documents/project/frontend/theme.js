// theme.js — тъмна/светла тема, помни избора на ученика между посещения
const Theme = (() => {
  const KEY = 'climby-theme';
  const root = document.documentElement;

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.textContent = theme === 'light' ? '🌙' : '☀️';
    btn.setAttribute('aria-label', theme === 'light' ? 'Включи тъмна тема' : 'Включи светла тема');
  }

  function toggle() {
    const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    localStorage.setItem(KEY, next);
    apply(next);
  }

  function init() {
    apply(localStorage.getItem(KEY) === 'light' ? 'light' : 'dark');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', toggle);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Theme.init);
