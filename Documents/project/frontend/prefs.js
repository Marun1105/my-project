// prefs.js — the settings that change how Climby reads, moves and teaches.
//
// Each one is a data attribute on <html>, set before the first paint so nothing
// flashes, and a row in Settings that shows the current choice. They live in
// localStorage: they are about this device and this eyes, not the account.
//
//   text     small | normal | large        the type scale
//   reading  normal | easy                 wider spacing and taller lines
//   autoread off | on                      speak every answer as it arrives
//   tutor    hints | full                  how much the tutor holds back
const Prefs = (() => {
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const DEFAULTS = { text: 'normal', reading: 'normal', autoread: 'off', tutor: 'hints' };

  function read(key) {
    try { return localStorage.getItem('climby-pref-' + key) || DEFAULTS[key]; }
    catch { return DEFAULTS[key]; }
  }

  function apply(key, value) {
    root.setAttribute('data-' + key, value);
    document.querySelectorAll(`[data-pref="${key}"]`).forEach(btn => {
      const active = btn.dataset.value === value;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('active', active);
    });
    // a dropdown shows its own value, but only once it is told
    document.querySelectorAll(`select[data-pref="${key}"]`).forEach(sel => { sel.value = value; });
  }

  function set(key, value) {
    try { localStorage.setItem('climby-pref-' + key, value); } catch { /* still applies for this session */ }
    apply(key, value);
    window.dispatchEvent(new CustomEvent('climby:pref-changed', { detail: { key, value } }));
  }

  function get(key) { return read(key); }

  // Before paint: the attributes are what the CSS keys on.
  Object.keys(DEFAULTS).forEach(k => root.setAttribute('data-' + k, read(k)));

  function init() {
    document.querySelectorAll('button[data-pref]').forEach(btn => {
      btn.addEventListener('click', () => set(btn.dataset.pref, btn.dataset.value));
    });
    document.querySelectorAll('select[data-pref]').forEach(sel => {
      sel.addEventListener('change', () => set(sel.dataset.pref, sel.value));
    });
    Object.keys(DEFAULTS).forEach(k => apply(k, read(k)));
  }

  document.addEventListener('DOMContentLoaded', init);

  return { get, set };
})();

window.Prefs = Prefs;
