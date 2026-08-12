// theme.js — тъмна/светла тема, помни избора на ученика между посещения
const Theme = (() => {
  const KEY = 'climby-theme';
  const root = document.documentElement;

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.textContent = theme === 'light' ? '🌙' : '☀️';
    btn.setAttribute('aria-label', window.t ? window.t(theme === 'light' ? 'theme.toDark' : 'theme.toLight') : '');
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
    window.addEventListener('climby:lang-changed', () => {
      apply(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Theme.init);
