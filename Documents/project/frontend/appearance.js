// appearance.js — the theme studio in Settings → Appearance.
//
// Builds the theme cards, the accent swatches and the Auto pickers, and keeps
// the little copy of the main screen (#themePreview) in step:
//   - it shows what is applied;
//   - pointing at a theme, a swatch or a look option shows that instead,
//     without applying anything ("Preview — click to apply");
//   - clicking applies it, to the whole app at once.
// The colours themselves are in themes.css; Theme (theme.js) does the applying.
const Appearance = (() => {
  const $ = id => document.getElementById(id);
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  let filter = 'all';
  let hovering = null; // { palette, look } while something is being pointed at

  // ---------- small builders ----------
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  // One miniature of the main screen. Painted with the palette, the current
  // look and no custom accent — a card shows the theme as it comes.
  function art(paletteId) {
    const a = el('span', 'tc-art',
      '<span class="tc-side"><i></i><i></i><i></i><i></i></span>' +
      '<span class="tc-body"><span class="tc-h"></span><span class="tc-l"></span>' +
      '<span class="tc-cards"><span></span><span></span></span>' +
      '<span class="tc-row"><span class="tc-acc"></span><span class="tc-ai"></span></span></span>');
    a.dataset.artFor = paletteId;
    return a;
  }

  function paletteName(id) { return t('theme.p.' + id); }

  function buildGallery() {
    const box = $('themeGallery');
    if (!box) return;
    box.textContent = '';

    const cards = [{ id: 'auto', base: 'auto' }].concat(Theme.palettes());
    cards.forEach(p => {
      const btn = el('button', 'theme-card');
      btn.type = 'button';
      btn.setAttribute('data-theme-pick', p.id);
      btn.dataset.base = p.base;
      btn.setAttribute('aria-pressed', 'false');

      if (p.id === 'auto') {
        // Auto is two themes at once: day on the left, night on the right.
        const split = el('span', 'tc-art tc-art-split');
        split.appendChild(art('@light'));
        split.appendChild(art('@dark'));
        btn.appendChild(split);
      } else {
        btn.appendChild(art(p.id));
      }

      const meta = el('span', 'tc-meta');
      const name = el('span', 'tc-name');
      name.setAttribute('data-i18n', 'theme.p.' + p.id);
      name.textContent = paletteName(p.id);
      const kind = el('span', 'tc-kind');
      const kindKey = p.base === 'auto' ? 'theme.kindAuto' : p.base === 'dark' ? 'theme.kindDark' : 'theme.kindLight';
      kind.setAttribute('data-i18n', kindKey);
      kind.textContent = t(kindKey);
      meta.appendChild(name);
      meta.appendChild(kind);
      btn.appendChild(meta);
      btn.appendChild(el('span', 'tc-check', CHECK));

      btn.addEventListener('click', () => { fade(); Theme.setTheme(p.id); });
      btn.addEventListener('pointerenter', () => hover({ palette: p.id === 'auto' ? Theme.resolve('auto') : p.id }));
      btn.addEventListener('focus', () => hover({ palette: p.id === 'auto' ? Theme.resolve('auto') : p.id }));
      btn.addEventListener('pointerleave', unhover);
      btn.addEventListener('blur', unhover);
      box.appendChild(btn);
    });
    paintCards();
    applyFilter();
  }

  // Cards follow the current look (corners, AI colour…) but not the accent.
  function paintCards() {
    const look = { ...Theme.getLook(), accent: '' };
    document.querySelectorAll('#themeGallery [data-art-for]').forEach(a => {
      let id = a.dataset.artFor;
      if (id === '@light') id = Theme.autoPalette('light');
      if (id === '@dark') id = Theme.autoPalette('dark');
      Theme.paint(a, id, look);
    });
  }

  function applyFilter() {
    document.querySelectorAll('[data-theme-filter]').forEach(b => {
      const on = b.dataset.themeFilter === filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('#themeGallery .theme-card').forEach(c => {
      const show = filter === 'all' || c.dataset.base === filter || c.dataset.base === 'auto';
      c.classList.toggle('is-hidden', !show);
    });
  }

  function buildAutoPickers() {
    [['light', 'themeAutoLight'], ['dark', 'themeAutoDark']].forEach(([base, id]) => {
      const sel = $(id);
      if (!sel) return;
      sel.textContent = '';
      Theme.palettes().filter(p => p.base === base).forEach(p => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = paletteName(p.id);
        sel.appendChild(o);
      });
      sel.value = Theme.autoPalette(base);
      if (!sel.dataset.wired) {
        sel.dataset.wired = '1';
        sel.addEventListener('change', () => { fade(); Theme.setAutoPalette(base, sel.value); });
      }
    });
  }

  function buildSwatches() {
    const box = $('accentSwatches');
    if (!box) return;
    box.textContent = '';

    const own = el('button', 'accent-swatch accent-swatch-theme');
    own.type = 'button';
    own.setAttribute('data-look', 'accent');
    own.setAttribute('data-value', '');
    const ownLabel = el('span');
    ownLabel.setAttribute('data-i18n', 'look.accentTheme');
    ownLabel.textContent = t('look.accentTheme');
    own.appendChild(ownLabel);
    box.appendChild(own);

    Theme.accents().forEach(hex => {
      const b = el('button', 'accent-swatch');
      b.type = 'button';
      b.setAttribute('data-look', 'accent');
      b.setAttribute('data-value', hex);
      b.setAttribute('aria-label', hex);
      b.title = hex;
      b.style.setProperty('--sw', hex);
      box.appendChild(b);
    });

    // Any colour at all, through the system colour picker.
    const custom = el('label', 'accent-swatch accent-custom');
    custom.title = t('look.accentCustom');
    const input = document.createElement('input');
    input.type = 'color';
    input.setAttribute('aria-label', t('look.accentCustom'));
    input.value = Theme.getLook().accent || '#a855f7';
    input.addEventListener('input', () => hover({ look: { accent: input.value } }));
    input.addEventListener('change', () => { hovering = null; Theme.setLook('accent', input.value); });
    custom.appendChild(input);
    box.appendChild(custom);

    wireLook(box);
  }

  // Segmented buttons and swatches: click applies, pointing previews.
  function wireLook(scope) {
    scope.querySelectorAll('button[data-look]').forEach(b => {
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      const key = b.getAttribute('data-look');
      const value = b.getAttribute('data-value') || '';
      b.addEventListener('click', () => { fade(); Theme.setLook(key, value); });
      b.addEventListener('pointerenter', () => hover({ look: { [key]: value } }));
      b.addEventListener('pointerleave', unhover);
    });
    scope.querySelectorAll('select[data-look]').forEach(sel => {
      if (sel.dataset.wired) return;
      sel.dataset.wired = '1';
      sel.addEventListener('change', () => { fade(); Theme.setLook(sel.getAttribute('data-look'), sel.value); });
    });
  }

  // ---------- the preview ----------
  function hover(change) {
    hovering = change;
    renderPreview();
  }
  function unhover() {
    hovering = null;
    renderPreview();
  }

  function renderPreview() {
    const box = $('themePreview');
    if (!box) return;
    const choice = Theme.getChoice();
    const applied = Theme.resolve(choice);
    const palette = (hovering && hovering.palette) || applied;
    const look = { ...Theme.getLook(), ...((hovering && hovering.look) || {}) };
    Theme.paint(box, palette, look);

    const previewing = !!hovering && (palette !== applied || JSON.stringify(look) !== JSON.stringify(Theme.getLook()));
    let name = paletteName(palette);
    if (!hovering && choice === 'auto') name = paletteName('auto') + ' · ' + name;
    $('themePreviewName').textContent = name;
    const state = $('themePreviewState');
    state.setAttribute('data-i18n', previewing ? 'theme.previewing' : 'theme.current');
    state.textContent = t(previewing ? 'theme.previewing' : 'theme.current');
    state.classList.toggle('is-preview', previewing);
  }

  function syncAutoRow() {
    const row = $('themeAutoRow');
    if (row) row.classList.toggle('hidden', Theme.getChoice() !== 'auto');
  }

  // A short cross-fade on the big surfaces when the theme changes.
  let fadeTimer = null;
  function fade() {
    const root = document.documentElement;
    if (root.getAttribute('data-motion') === 'off') return;
    root.classList.add('theme-fading');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => root.classList.remove('theme-fading'), 450);
  }

  // ---------- the section list: show where you are ----------
  function trackSections() {
    const main = document.querySelector('#settingsOverlay .settings-main');
    const links = Array.from(document.querySelectorAll('[data-settings-jump]'));
    if (!main || !links.length) return;
    const update = () => {
      if (!main.clientHeight) return;
      const top = main.getBoundingClientRect().top + 40;
      let current = links[0];
      links.forEach(l => {
        const sec = document.getElementById(l.dataset.settingsJump);
        if (sec && !sec.classList.contains('hidden') && sec.getBoundingClientRect().top <= top) current = l;
      });
      // at the very bottom the last visible group is the one being read
      if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) {
        const visible = links.filter(l => { const s = document.getElementById(l.dataset.settingsJump); return s && !s.classList.contains('hidden'); });
        current = visible[visible.length - 1] || current;
      }
      links.forEach(l => l.classList.toggle('active', l === current));
    };
    main.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // Hidden, every group measures 0 and the last one "wins": measure again
    // each time Settings opens.
    const overlay = document.getElementById('settingsOverlay');
    new MutationObserver(() => { if (!overlay.classList.contains('hidden')) requestAnimationFrame(update); })
      .observe(overlay, { attributes: true, attributeFilter: ['class'] });
    update();
  }

  function refresh() {
    paintCards();
    renderPreview();
    syncAutoRow();
    Theme.updateControls();
  }

  function init() {
    if (!$('themeGallery')) return;
    buildGallery();
    buildSwatches();
    buildAutoPickers();
    wireLook(document);

    document.querySelectorAll('[data-theme-filter]').forEach(b => {
      b.addEventListener('click', () => { filter = b.dataset.themeFilter; applyFilter(); });
    });
    $('lookResetBtn').addEventListener('click', () => { fade(); Theme.resetLook(); });

    // From the account menu straight to the gallery.
    const more = $('themeMoreBtn');
    if (more) {
      more.addEventListener('click', () => {
        $('settingsMenuBtn').click();
        const target = $('setAppearance');
        if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
      });
    }
    // The quick switch in the account menu changes the theme too; fade it.
    document.querySelectorAll('[data-theme-mode]').forEach(b => b.addEventListener('click', fade));

    window.addEventListener('climby:theme-changed', refresh);
    window.addEventListener('climby:lang-changed', () => { buildAutoPickers(); renderPreview(); });
    trackSections();
    refresh();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { refresh };
})();

window.Appearance = Appearance;
