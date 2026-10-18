// profile-photo.js — your picture, and a small editor to frame it.
//
// Settings → Account: press the round photo, pick an image, then drag it into
// place, zoom with the slider (or the wheel) and turn it if the phone took it
// sideways. What is inside the circle is saved, 256 px square.
//
// For now the photo lives on this device only, per account. Sharing it with
// friends comes with the social features, and needs the server to keep it.
const ProfilePhoto = (() => {
  const PREFIX = 'climby-photo:';
  const OUT = 256;          // the saved picture, in pixels
  const VIEW = 280;         // the editor's circle, in CSS pixels
  const $ = id => document.getElementById(id);
  const t = (k, v) => (window.t ? window.t(k, v) : k);

  function owner() {
    const u = window.Auth && Auth.getUser();
    return u && u.id ? String(u.id) : null;
  }

  function get() {
    const id = owner();
    if (!id) return null;
    try { return localStorage.getItem(PREFIX + id); } catch { return null; }
  }

  function set(dataUrl) {
    const id = owner();
    if (!id) return false;
    try {
      if (dataUrl) localStorage.setItem(PREFIX + id, dataUrl);
      else localStorage.removeItem(PREFIX + id);
    } catch { return false; }
    window.dispatchEvent(new CustomEvent('climby:photo-changed'));
    return true;
  }

  // Any round avatar: the photo if there is one, otherwise the initial.
  function paint(el, initial) {
    if (!el) return;
    const photo = get();
    el.classList.toggle('has-photo', !!photo);
    el.style.backgroundImage = photo ? `url("${photo}")` : '';
    el.textContent = photo ? '' : (initial || '?');
  }

  // ------------------------------------------------------------ the editor
  let root, canvas, ctx, zoomInput, img = null;
  let state = { zoom: 1, rot: 0, x: 0, y: 0 };   // x, y: the image centre's offset from the circle's, in view px

  function build() {
    root = document.createElement('div');
    root.className = 'photo-editor hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'photoEditorTitle');
    root.innerHTML = `
      <div class="photo-editor-card">
        <h3 id="photoEditorTitle" data-i18n="photo.title"></h3>
        <p class="settings-note" data-i18n="photo.hint"></p>
        <div class="photo-stage">
          <canvas width="${VIEW * 2}" height="${VIEW * 2}" aria-hidden="true"></canvas>
          <div class="photo-ring" aria-hidden="true"></div>
        </div>
        <div class="photo-tools">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M8.5 11h5"/></svg>
          <input class="photo-zoom" type="range" min="1" max="4" step="0.01" value="1" data-i18n-aria="photo.zoom">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M8.5 11h5M11 8.5v5"/></svg>
          <button type="button" class="btn-secondary photo-rotate" data-i18n-aria="photo.rotate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button>
        </div>
        <div class="photo-actions">
          <button type="button" class="btn-ghost photo-remove" data-i18n="photo.remove"></button>
          <span class="tour-spacer"></span>
          <button type="button" class="btn-secondary photo-cancel" data-i18n="photo.cancel"></button>
          <button type="button" class="btn-primary photo-save" data-i18n="photo.save"></button>
        </div>
      </div>`;
    document.body.appendChild(root);
    if (window.I18n) I18n.applyToDom();
    canvas = root.querySelector('canvas');
    ctx = canvas.getContext('2d');
    zoomInput = root.querySelector('.photo-zoom');

    zoomInput.addEventListener('input', () => { state.zoom = Number(zoomInput.value); clamp(); draw(); });
    root.querySelector('.photo-rotate').addEventListener('click', () => { state.rot = (state.rot + 90) % 360; clamp(); draw(); });
    root.querySelector('.photo-cancel').addEventListener('click', close);
    root.querySelector('.photo-save').addEventListener('click', save);
    root.querySelector('.photo-remove').addEventListener('click', () => { set(null); close(); });
    root.addEventListener('click', e => { if (e.target === root) close(); });
    root.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      const step = 8;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key] && e.target === canvas.parentElement) {
        e.preventDefault();
        state.x += moves[e.key][0]; state.y += moves[e.key][1]; clamp(); draw();
      }
    });

    // dragging, with a mouse, a finger or a pen
    const stage = root.querySelector('.photo-stage');
    stage.tabIndex = 0;
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', t('photo.hint'));
    let drag = null;
    stage.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, sx: state.x, sy: state.y };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) return;
      state.x = drag.sx + (e.clientX - drag.x);
      state.y = drag.sy + (e.clientY - drag.y);
      clamp(); draw();
    });
    const end = () => { drag = null; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      state.zoom = Math.min(4, Math.max(1, state.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      zoomInput.value = String(state.zoom);
      clamp(); draw();
    }, { passive: false });
  }

  // The image's size in view pixels at zoom 1: just big enough to fill the circle.
  function baseScale() {
    const turned = state.rot % 180 !== 0;
    const w = turned ? img.height : img.width;
    const h = turned ? img.width : img.height;
    return VIEW / Math.min(w, h);
  }

  // Never let the picture leave a gap inside the circle.
  function clamp() {
    if (!img) return;
    const turned = state.rot % 180 !== 0;
    const s = baseScale() * state.zoom;
    const w = (turned ? img.height : img.width) * s;
    const h = (turned ? img.width : img.height) * s;
    const mx = Math.max(0, (w - VIEW) / 2);
    const my = Math.max(0, (h - VIEW) / 2);
    state.x = Math.min(mx, Math.max(-mx, state.x));
    state.y = Math.min(my, Math.max(-my, state.y));
  }

  function render(target, size) {
    const c = target.getContext('2d');
    const k = size / VIEW;
    c.save();
    c.clearRect(0, 0, size, size);
    c.translate(size / 2 + state.x * k, size / 2 + state.y * k);
    c.rotate(state.rot * Math.PI / 180);
    const s = baseScale() * state.zoom * k;
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, -img.width * s / 2, -img.height * s / 2, img.width * s, img.height * s);
    c.restore();
  }

  function draw() { if (img) render(canvas, canvas.width); }

  function save() {
    if (!img) return close();
    const out = document.createElement('canvas');
    out.width = out.height = OUT;
    render(out, OUT);
    const ok = set(out.toDataURL('image/jpeg', 0.86));
    if (!ok && window.Toast) Toast.show(t('photo.saveError'));
    close();
  }

  let cameFrom = null;
  function open(file) {
    if (!root) build();
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      img = image;
      state = { zoom: 1, rot: 0, x: 0, y: 0 };
      zoomInput.value = '1';
      root.querySelector('.photo-remove').classList.toggle('hidden', !get());
      cameFrom = document.activeElement;
      root.classList.remove('hidden');
      draw();
      root.querySelector('.photo-stage').focus();
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      if (window.Toast) Toast.show(t('photo.badFile'));
    };
    image.src = url;
  }

  function close() {
    if (!root) return;
    root.classList.add('hidden');
    img = null;
    if (cameFrom && cameFrom.focus) cameFrom.focus();
  }

  function init() {
    const btn = $('profilePhotoBtn');
    const input = $('profilePhotoInput');
    if (!btn || !input) return;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) open(file);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  return { get, paint, open };
})();

window.ProfilePhoto = ProfilePhoto;
