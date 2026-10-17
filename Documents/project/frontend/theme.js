// theme.js — how Climby looks: the theme (a palette) and the "look" options on top of it.
//
// Theme. One of the palettes below, or 'auto', which follows the system and uses
// the student's chosen light palette by day and dark palette by night. Every
// palette sits on one of the two bases the stylesheet already knows (data-theme
// = light | dark), so every rule written for "the light theme" still applies to
// all the light palettes. The palette itself is data-palette on <html>; its
// colours live in themes.css.
//
// Look. Accent colour, AI colour, background, glass, corners, font, the logo
// watermark and motion. Each is a data attribute on <html> (the accent is a set
// of CSS variables, because it is any colour).
//
// The same attributes work on any element, not just <html>: that is how the
// theme cards and the preview in Settings show a palette without applying it.
//
// All of it lives in localStorage: it is about this device and these eyes.
// It is applied the moment this script runs, before DOMContentLoaded, so there
// is no flash of the wrong theme.
const Theme = (() => {
  const KEY = 'climby-theme';            // 'auto' or a palette id (old 'light'/'dark' still read)
  const KEY_LIGHT = 'climby-theme-light'; // the palette 'auto' uses by day
  const KEY_DARK = 'climby-theme-dark';   // …and by night
  const KEY_LOOK = 'climby-look';

  // Order is the order of the gallery. Midnight and Daylight are the original
  // Climby themes, so they come first in their halves.
  const PALETTES = [
    { id: 'midnight', base: 'dark' },
    { id: 'galaxy', base: 'dark' },
    { id: 'ocean', base: 'dark' },
    { id: 'northern', base: 'dark' },
    { id: 'forest', base: 'dark' },
    { id: 'sunset', base: 'dark' },
    { id: 'ember', base: 'dark' },
    { id: 'neon', base: 'dark' },
    { id: 'slate', base: 'dark' },
    { id: 'contrast', base: 'dark' },
    { id: 'daylight', base: 'light' },
    { id: 'lavender', base: 'light' },
    { id: 'sky', base: 'light' },
    { id: 'mint', base: 'light' },
    { id: 'sakura', base: 'light' },
    { id: 'peach', base: 'light' },
    { id: 'paper', base: 'light' },
  ];
  const BY_ID = Object.fromEntries(PALETTES.map(p => [p.id, p]));
  const LEGACY = { light: 'daylight', dark: 'midnight' };

  const LOOK_DEFAULTS = {
    accent: '',          // '' = the palette's own; otherwise a #hex
    ai: 'climby',        // climby (the violet wave) | theme (the palette's own wave)
    bg: 'glow',          // plain | glow (the original) | aurora | dots
    glass: 'frosted',    // frosted | solid
    corners: 'soft',     // sharp | soft | round
    font: 'inter',       // inter | manrope | system
    watermark: 'on',     // on | off
    motion: 'on',        // on | off
  };
  const LOOK_VALUES = {
    ai: ['climby', 'theme'],
    bg: ['plain', 'glow', 'aurora', 'dots'],
    glass: ['frosted', 'solid'],
    corners: ['sharp', 'soft', 'round'],
    font: ['inter', 'manrope', 'system'],
    watermark: ['on', 'off'],
    motion: ['on', 'off'],
  };
  const ACCENTS = ['#a855f7', '#6366f1', '#3b82f6', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#94a3b8'];

  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  // ---------- storage ----------
  function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function save(key, value) { try { localStorage.setItem(key, value); } catch { /* still applies for this visit */ } }

  function getChoice() {
    const saved = load(KEY);
    if (saved === 'auto') return 'auto';
    if (LEGACY[saved]) return LEGACY[saved];
    return BY_ID[saved] ? saved : 'auto';
  }
  function autoPalette(base) {
    const key = base === 'dark' ? KEY_DARK : KEY_LIGHT;
    const saved = load(key);
    if (BY_ID[saved] && BY_ID[saved].base === base) return saved;
    return base === 'dark' ? 'midnight' : 'daylight';
  }
  function systemBase() { return media && media.matches ? 'dark' : 'light'; }
  function resolve(choice) { return choice === 'auto' ? autoPalette(systemBase()) : choice; }

  function getLook() {
    let saved = {};
    try { saved = JSON.parse(load(KEY_LOOK) || '{}') || {}; } catch { saved = {}; }
    const look = { ...LOOK_DEFAULTS };
    Object.keys(LOOK_VALUES).forEach(k => { if (LOOK_VALUES[k].includes(saved[k])) look[k] = saved[k]; });
    if (typeof saved.accent === 'string' && /^#[0-9a-f]{6}$/i.test(saved.accent)) look.accent = saved.accent.toLowerCase();
    return look;
  }

  // ---------- colour helpers for a custom accent ----------
  function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function luminance(hex) {
    return rgb(hex).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  }
  function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function mix(hex, other, amount) {
    const a = rgb(hex), b = rgb(other);
    return '#' + a.map((c, i) => Math.round(c + (b[i] - c) * amount).toString(16).padStart(2, '0')).join('');
  }
  // A swatch is one colour; on a light page it needs to be dark enough to read
  // as text and on a dark page light enough. Nudge it until it holds 4.5:1.
  function accentVars(hex, base) {
    const page = base === 'dark' ? '#0c0c10' : '#ffffff';
    const toward = base === 'dark' ? '#ffffff' : '#000000';
    let accent = hex;
    for (let i = 1; i <= 10 && contrast(accent, page) < 4.5; i++) accent = mix(hex, toward, i * 0.08);
    const on = contrast(accent, '#0d0d10') >= contrast(accent, '#ffffff') ? '#0d0d10' : '#ffffff';
    const [r, g, b] = rgb(accent);
    return {
      '--accent': accent,
      '--accent-strong': mix(accent, '#000000', 0.18),
      '--accent-soft': `rgba(${r}, ${g}, ${b}, ${base === 'dark' ? 0.16 : 0.12})`,
      '--on-accent': on,
      '--blue': accent,
      '--blue-soft': `rgba(${r}, ${g}, ${b}, 0.12)`,
      '--pink': accent,
    };
  }
  const ACCENT_PROPS = Object.keys(accentVars('#888888', 'dark'));

  // ---------- applying ----------
  // Paints a palette + look onto any element. <html> gets it for real; the
  // preview and the gallery cards get it to show what it would look like.
  function paint(el, paletteId, look) {
    const palette = BY_ID[paletteId] || BY_ID.midnight;
    el.setAttribute('data-theme', palette.base);
    el.setAttribute('data-palette', palette.id);
    Object.keys(LOOK_VALUES).forEach(k => el.setAttribute('data-' + (k === 'ai' ? 'aicolor' : k), look[k]));
    ACCENT_PROPS.forEach(p => el.style.removeProperty(p));
    if (look.accent) {
      const vars = accentVars(look.accent, palette.base);
      Object.keys(vars).forEach(p => el.style.setProperty(p, vars[p]));
    }
  }

  function updateMetaColor() {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (!bg) return;
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg));
  }

  function render(notify) {
    const choice = getChoice();
    const paletteId = resolve(choice);
    const look = getLook();
    paint(root, paletteId, look);
    updateControls();
    // Every change is announced, even one that leaves this palette as it was
    // (Auto's night palette changed while it is day): the studio repaints its cards.
    if (notify) {
      updateMetaColor();
      window.dispatchEvent(new CustomEvent('climby:theme-changed', {
        detail: { theme: BY_ID[paletteId].base, palette: paletteId, mode: choice, look },
      }));
    }
    return BY_ID[paletteId].base;
  }

  // ---------- public setters ----------
  function setTheme(choice) {
    if (choice !== 'auto' && !BY_ID[choice]) return;
    save(KEY, choice);
    // Picking a palette by hand also teaches 'auto' which one to use for its half,
    // so switching back to Auto does not throw away the choice.
    if (choice !== 'auto') save(BY_ID[choice].base === 'dark' ? KEY_DARK : KEY_LIGHT, choice);
    render(true);
  }
  function setAutoPalette(base, id) {
    if (!BY_ID[id] || BY_ID[id].base !== base) return;
    save(base === 'dark' ? KEY_DARK : KEY_LIGHT, id);
    render(true);
  }
  function setLook(key, value) {
    const look = getLook();
    if (key === 'accent') look.accent = /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : '';
    else if (LOOK_VALUES[key] && LOOK_VALUES[key].includes(value)) look[key] = value;
    else return;
    save(KEY_LOOK, JSON.stringify(look));
    render(true);
  }
  function resetLook() {
    save(KEY_LOOK, JSON.stringify(LOOK_DEFAULTS));
    render(true);
  }

  // The old three-way switch (still in the account menu): Auto / Light / Dark.
  // Light and Dark go to the student's palette for that half, not back to plain white.
  function setMode(mode) {
    if (mode === 'auto') setTheme('auto');
    else if (mode === 'light' || mode === 'dark') {
      const current = getChoice();
      if (current !== 'auto' && BY_ID[current].base === mode) return;
      setTheme(autoPalette(mode));
    }
  }
  function getMode() {
    const choice = getChoice();
    return choice === 'auto' ? 'auto' : BY_ID[choice].base;
  }

  // ---------- controls that live anywhere in the page ----------
  function updateControls() {
    const mode = getMode();
    const choice = getChoice();
    const look = getLook();
    document.querySelectorAll('[data-theme-mode]').forEach(btn => {
      const active = btn.getAttribute('data-theme-mode') === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-theme-pick]').forEach(btn => {
      const active = btn.getAttribute('data-theme-pick') === choice;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-look]').forEach(el => {
      const k = el.getAttribute('data-look');
      if (el.tagName === 'SELECT') { el.value = look[k]; return; }
      const active = (el.getAttribute('data-value') || '') === (look[k] || '');
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('select[data-auto-palette]').forEach(sel => {
      sel.value = autoPalette(sel.getAttribute('data-auto-palette'));
    });
  }

  function wireControls(scope) {
    (scope || document).querySelectorAll('[data-theme-mode]').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => setMode(btn.getAttribute('data-theme-mode')));
    });
  }

  // Apply now, synchronously: <html> exists already, so there is no flash.
  render(false);

  if (media) {
    media.addEventListener('change', () => { if (getChoice() === 'auto') render(true); });
  }

  function init() {
    wireControls();
    render(true);
    updateMetaColor();
    window.addEventListener('climby:lang-changed', updateControls);
  }

  return {
    init, setMode, getMode, setTheme, setAutoPalette, setLook, resetLook, paint, updateControls,
    getChoice, getLook, resolve, autoPalette,
    palettes: () => PALETTES.slice(),
    accents: () => ACCENTS.slice(),
    getEffectiveTheme: () => BY_ID[resolve(getChoice())].base,
    getPalette: () => resolve(getChoice()),
  };
})();

window.Theme = Theme;
document.addEventListener('DOMContentLoaded', Theme.init);
