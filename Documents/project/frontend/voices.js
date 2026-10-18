// voices.js — choose the voice that reads the answers, and hear it first.
//
// Until now speak.js took whichever voice the operating system happened to
// list first for the language. On this machine that is "Microsoft David" — a
// flat, robotic voice — while Zira and Mark sit right behind it, unreachable.
// No setting, no way to hear one before committing, and no explanation when a
// language has no voice at all.
//
// So: a list of the voices that can actually speak the app's language, each
// with a play button that reads a real sentence in that voice. The choice is
// kept per language, because picking an English voice says nothing about which
// Bulgarian one you want.
//
// When the language has no voice installed — Bulgarian, on a default Windows —
// the list says so plainly and tells you where to add one, instead of the
// read-aloud button silently never appearing.
const Voices = (() => {
  const KEY = 'climby-voice-';          // + the language code
  const synth = window.speechSynthesis;

  // A sentence worth judging a voice by: long enough to hear its rhythm, and
  // about the thing the voice will actually be doing.
  const SAMPLE = {
    en: 'Let us take this one step at a time. First, what do we already know?',
    bg: 'Нека я решим стъпка по стъпка. Първо: какво вече знаем?',
  };

  function langCode() {
    return (window.I18n ? I18n.get() : 'en') === 'bg' ? 'bg' : 'en';
  }

  function all() {
    return synth ? synth.getVoices() : [];
  }

  // Every voice that can speak this language.
  function forLang(code) {
    return all().filter(v => (v.lang || '').toLowerCase().startsWith(code));
  }

  // How good a voice is likely to be, without being able to listen to it.
  // Windows ships two generations under similar names: the older SAPI5 ones
  // are suffixed "Desktop" and sound markedly worse than the OneCore ones of
  // the same name. "Natural" and "Online" mark the newest and best.
  function rank(v) {
    const name = (v.name || '').toLowerCase();
    let score = 0;
    if (/natural|neural/.test(name)) score += 40;
    if (!v.localService) score += 20;            // a network voice is the good kind
    if (/\bdesktop\b/.test(name)) score -= 30;   // the old SAPI5 generation
    if (v.default) score += 5;
    return score;
  }

  function ranked(code) {
    return forLang(code).slice().sort((a, b) => rank(b) - rank(a));
  }

  // The voice speak.js should use: the one chosen for this language if it is
  // still installed, otherwise the best guess.
  function chosen(code) {
    code = code || langCode();
    const list = forLang(code);
    if (!list.length) return null;
    let saved = null;
    try { saved = localStorage.getItem(KEY + code); } catch { /* no storage, no memory */ }
    // matched by name: voiceURI is not stable across machines or restarts
    return list.find(v => v.name === saved) || ranked(code)[0] || null;
  }

  function choose(code, name) {
    try { localStorage.setItem(KEY + code, name); } catch { /* applies for this session */ }
    window.dispatchEvent(new CustomEvent('climby:voice-changed', { detail: { lang: code, name } }));
  }

  // ---------------------------------------------------------------- the panel

  // "Microsoft Zira - English (United States)" is the machine's name for it.
  // "Zira" is the name a person would use.
  function shortName(v) {
    let n = (v.name || '').replace(/^Microsoft\s+/i, '').replace(/\s*-\s*.*$/, '');
    return n.replace(/\b(Desktop|Online|Natural)\b/gi, '').trim() || v.name;
  }

  function detail(v) {
    const bits = [];
    if (/natural|neural/i.test(v.name)) bits.push(window.t ? t('voice.natural') : 'Natural-sounding');
    else if (/\bdesktop\b/i.test(v.name)) bits.push(window.t ? t('voice.older') : 'Standard voice');
    else bits.push(window.t ? t('voice.device') : 'Device voice');
    if (!v.localService) bits.push(window.t ? t('voice.online') : 'Online');
    bits.push(v.lang.replace('-', ' · '));
    return bits.join(' · ');
  }

  let speaking = null;   // the card currently demonstrating itself

  function stopSample() {
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    if (speaking) speaking.classList.remove('is-playing');
    speaking = null;
  }

  function playSample(voice, card) {
    const wasThis = speaking === card;
    stopSample();
    if (wasThis) return;               // pressing the playing one stops it
    const code = langCode();
    const u = new SpeechSynthesisUtterance(SAMPLE[code] || SAMPLE.en);
    u.voice = voice;
    u.lang = voice.lang;
    u.onend = u.onerror = () => { if (speaking === card) stopSample(); };
    speaking = card;
    card.classList.add('is-playing');
    synth.speak(u);
  }

  const PLAY = '<svg class="voice-ico-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const PAUSE = '<svg class="voice-ico-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';
  // The wave: still and low until the voice speaks, then every bar moves on
  // its own beat. Heights are fixed per bar so it reads as a voice, not noise.
  const WAVE = [5, 9, 14, 8, 18, 11, 22, 13, 17, 9, 20, 12, 15, 7, 11, 6];

  function card(voice, code, picked) {
    const el = document.createElement('div');
    el.className = 'voice-card';
    el.dataset.voiceName = voice.name;

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'voice-play';
    play.innerHTML = PLAY + PAUSE;
    play.setAttribute('aria-label', (window.t ? t('voice.test') : 'Hear') + ' ' + shortName(voice));
    play.addEventListener('click', e => { e.stopPropagation(); playSample(voice, el); });

    const wave = document.createElement('span');
    wave.className = 'voice-wave';
    wave.setAttribute('aria-hidden', 'true');
    WAVE.forEach((h, i) => {
      const bar = document.createElement('i');
      bar.style.setProperty('--h', h + 'px');
      bar.style.animationDelay = (i * 0.07 % 0.6).toFixed(2) + 's';
      wave.appendChild(bar);
    });

    const name = document.createElement('span');
    name.className = 'voice-name';
    name.textContent = shortName(voice);
    const meta = document.createElement('span');
    meta.className = 'voice-meta';
    meta.textContent = detail(voice);
    const text = document.createElement('span');
    text.className = 'voice-text';
    text.append(name, meta);
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'voice-select' + (picked ? ' is-picked' : '');
    select.setAttribute('role', 'radio');
    select.setAttribute('aria-checked', picked ? 'true' : 'false');
    select.tabIndex = picked ? 0 : -1;
    select.appendChild(text);

    const tick = document.createElement('span');
    tick.className = 'voice-tick';
    tick.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

    select.appendChild(tick);
    el.append(play, wave, select);
    select.addEventListener('click', () => {
      choose(code, voice.name);
      render();
      document.querySelector('#voicePicker .voice-select[aria-checked="true"]')?.focus();
    });
    select.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return;
      e.preventDefault();
      const options = [...document.querySelectorAll('#voicePicker .voice-select')];
      const current = options.indexOf(select);
      const offset = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      const next = options[(current + offset + options.length) % options.length];
      const nextVoice = listVoiceName(next);
      choose(code, nextVoice);
      render();
      document.querySelector(`#voicePicker .voice-select[aria-checked="true"]`)?.focus();
    });
    return el;
  }

  function listVoiceName(button) {
    const card = button && button.closest('.voice-card');
    return card ? card.dataset.voiceName : '';
  }

  function render() {
    const host = document.getElementById('voicePicker');
    if (!host) return;
    stopSample();
    host.innerHTML = '';
    host.removeAttribute('role');
    const code = langCode();
    const list = ranked(code);

    if (!list.length) {
      // Bulgarian on a stock Windows lands here. Saying so is the whole point:
      // before this, the read-aloud button simply never appeared and there was
      // nothing anywhere to explain why.
      const none = document.createElement('div');
      none.className = 'voice-none';
      none.innerHTML =
        '<p class="voice-none-title" data-i18n="voice.noneTitle">' +
        (window.t ? t('voice.noneTitle') : 'No voice for this language') + '</p>' +
        '<p class="settings-note" data-i18n="voice.noneBody">' +
        (window.t ? t('voice.noneBody') : '') + '</p>';
      host.appendChild(none);
      return;
    }

    // A horizontal rail: the cards slide sideways, with arrows on a wide
    // screen and a swipe on a phone.
    const prev = arrow('prev');
    const next = arrow('next');
    const rail = document.createElement('div');
    rail.className = 'voice-rail';
    rail.setAttribute('role', 'radiogroup');
    rail.setAttribute('aria-label', window.t ? t('settings.voice') : 'Voice');
    const picked = chosen(code);
    for (const v of list) rail.appendChild(card(v, code, picked && v.name === picked.name));
    host.append(prev, rail, next);
    const sync = () => {
      prev.disabled = rail.scrollLeft <= 2;
      next.disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 2;
      host.classList.toggle('fits', prev.disabled && next.disabled);
    };
    prev.addEventListener('click', () => rail.scrollBy({ left: -rail.clientWidth * 0.8, behavior: 'smooth' }));
    next.addEventListener('click', () => rail.scrollBy({ left: rail.clientWidth * 0.8, behavior: 'smooth' }));
    rail.addEventListener('scroll', sync, { passive: true });
    requestAnimationFrame(() => {
      const on = rail.querySelector('.voice-select.is-picked');
      if (on) rail.scrollLeft = Math.max(0, on.closest('.voice-card').offsetLeft - rail.offsetLeft - 8);
      sync();
    });
  }

  function arrow(which) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'voice-arrow voice-arrow-' + which;
    b.setAttribute('aria-label', window.t ? t(which === 'prev' ? 'voice.prev' : 'voice.next') : which);
    b.innerHTML = which === 'prev'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    return b;
  }

  function init() {
    if (!synth) return;
    render();
    // the list arrives late, and again when the system's voices change
    synth.addEventListener('voiceschanged', render);
    window.addEventListener('climby:lang-changed', render);
    // a voice talking to itself inside a panel nobody is looking at
    window.addEventListener('climby:settings-closed', stopSample);
    // the system may have gained or lost voices since the page loaded
    window.addEventListener('climby:settings-opened', render);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopSample(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { chosen, render, stopSample, shortName };
})();

window.Voices = Voices;
