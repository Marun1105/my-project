// speak.js — read the AI's answer aloud.
//
// Climby serves grades 1 to 12, and a seven-year-old cannot read four
// paragraphs about a subtraction problem: the answer was being delivered in a
// form the youngest students could not consume. The browser's own speech
// engine reads it, in the app's language, for free.
//
// One button, one job. Press to read from the top, press again to stop. It
// stops by itself when a new question is asked, when the screen changes, or
// when the window is hidden — a voice carrying on over a screen you have left
// is the one thing that would make a parent switch this off for good.
const Speak = (() => {
  const synth = window.speechSynthesis;
  let button = null;
  let current = null;   // the utterance in flight, if any

  function lang() {
    const l = window.I18n ? I18n.get() : 'en';
    return l === 'bg' ? 'bg-BG' : 'en-US';
  }

  // The voice the student picked for this language, or the best one going.
  // voices.js owns that decision and remembers it; this is the fallback for
  // when it has not loaded. Voices arrive asynchronously, so the list can be
  // empty on the first call.
  function voiceFor(code) {
    const prefix = code.slice(0, 2).toLowerCase();
    if (window.Voices) return Voices.chosen(prefix);
    if (!synth) return null;
    return synth.getVoices().find(v => (v.lang || '').toLowerCase().startsWith(prefix)) || null;
  }

  // The computer's best voice for this language, for when the online one fails.
  function localVoice(code) {
    if (!synth) return null;
    const prefix = code.slice(0, 2).toLowerCase();
    return synth.getVoices().find(v => (v.lang || '').toLowerCase().startsWith(prefix)) || null;
  }

  // Long answers go to the online voice in parts, a sentence boundary at a
  // time, so the first words play while the rest is still on its way.
  function parts(text) {
    const out = [];
    let cur = '';
    for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*/g) || [text]) {
      if ((cur + sentence).length > 900 && cur) { out.push(cur.trim()); cur = ''; }
      cur += sentence;
      while (cur.length > 2000) { out.push(cur.slice(0, 2000)); cur = cur.slice(2000); }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // What gets read. Not innerText: KaTeX renders every formula twice — a hidden
  // MathML copy for assistive tech and the visible one — so innerText would
  // speak each equation twice. Buttons and the task card inside an answer are
  // interface, not answer: before they were excluded the voice read "Add to my
  // Route" aloud, in the tutor's voice, to the seven-year-olds this exists for.
  // The badge is a logo, not content. Formulas come out as their symbols:
  // "x = 2" reads well, a stacked fraction reads as its numbers in order.
  // Honest limit; step-by-step playback is where to do better than this.
  function textOf(el) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('button, .katex-mathml, .ai-badge, .suggest-list').forEach(n => n.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function setSpeaking(on) {
    if (!button) return;
    button.classList.toggle('is-speaking', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', window.t ? t(on ? 'tutor.stopReading' : 'tutor.readAloud') : (on ? 'Stop' : 'Read aloud'));
    button.title = button.getAttribute('aria-label');
  }

  let audio = null;          // the online voice playing, if any
  let run = 0;               // bumped on every stop: an old part arriving late is dropped
  function stop() {
    run++;
    if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); audio = null; }
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    current = null;
    setSpeaking(false);
    document.querySelectorAll('.speak-btn.is-speaking').forEach(b => b.classList.remove('is-speaking'));
  }

  function start(el) {
    stop();
    const text = textOf(el);
    if (!text) return;
    const code = lang();
    const voice = voiceFor(code);
    if (voice && voice.cloud) { speakOnline(voice, text, code); return; }
    speakLocal(text, code, voice);
  }

  function speakLocal(text, code, voice) {
    if (!synth) { setSpeaking(false); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = code;
    if (voice && !voice.cloud) u.voice = voice;
    u.onend = u.onerror = () => { if (current === u) { current = null; setSpeaking(false); } };
    current = u;
    setSpeaking(true);
    synth.speak(u);
  }

  // Part after part, the next one fetched while this one plays. If the online
  // voice fails (the day's cap, no connection), the rest is read by the
  // computer's own voice, if it has one for this language.
  async function speakOnline(voice, text, code) {
    const mine = ++run;
    const list = parts(text);
    current = { online: true };
    setSpeaking(true);
    let next = Voices.fetchAudio(voice, list[0]);
    for (let i = 0; i < list.length; i++) {
      let url;
      try { url = await next; } catch {
        if (mine !== run) return;
        const rest = list.slice(i).join(' ');
        const fallback = localVoice(code);
        current = null;
        if (fallback) speakLocal(rest, code, fallback); else setSpeaking(false);
        return;
      }
      if (mine !== run) { URL.revokeObjectURL(url); return; }
      if (i + 1 < list.length) next = Voices.fetchAudio(voice, list[i + 1]);
      next && next.catch(() => {});        // a failure is handled when it is reached
      audio = new Audio(url);
      const ended = new Promise(resolve => { audio.onended = audio.onerror = resolve; });
      try { await audio.play(); } catch { /* blocked: the end comes at once */ }
      await ended;
      URL.revokeObjectURL(url);
      if (mine !== run) return;
    }
    audio = null;
    current = null;
    setSpeaking(false);
  }

  function toggle(el) {
    // The thread has one speaker per answer. Whichever was pressed is the one
    // whose state should change — not the most recently attached.
    const wasSpeaking = !!current;
    stop();
    button = el.querySelector('.speak-btn') || button;
    if (!wasSpeaking) start(el);
  }

  // Called by tutor.js after every render. The answer's HTML is rebuilt each
  // time, so the button is too; anything still speaking belongs to the old
  // answer and is cut off.
  function attach(el, opts) {
    stop();
    if (!el) return;
    // No voice for this language, online or on this machine: no button. A Bulgarian
    // answer read with an English voice is worse than nothing.
    if (!voiceFor(lang())) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'speak-btn';
    b.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/>' +
      '<path class="speak-wave" d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>';
    b.addEventListener('click', () => toggle(el));
    el.insertBefore(b, el.firstChild);
    button = b;
    setSpeaking(false);
    // A choice in Settings: every answer is read as it arrives, for the student
    // who would otherwise press the button every time — or cannot find it.
    // Not when we are only putting a missing button back on an old answer:
    // that would have the app read out last session's chat on a fresh load,
    // from a panel that is still closed.
    if (!(opts && opts.silent) && window.Prefs && Prefs.get('autoread') === 'on') start(el);
  }

  function init() {
    // Voices arrive late — the computer's, and the online list from the
    // server; a button decided against before they load would be wrong.
    // Re-attach once they are known, if an answer is on screen.
    const reattach = () => {
      const answers = [...document.querySelectorAll('.answer:not(.hidden), .chat-ai')];
      for (const el of answers) {
        if (el.classList.contains('chat-thinking') || el.classList.contains('chat-error')) continue;
        if (el.querySelector('.speak-btn')) continue;
        attach(el, { silent: true });
      }
    };
    if (synth) synth.addEventListener('voiceschanged', reattach);
    window.addEventListener('climby:voices-online', reattach);
    window.addEventListener('climby:view-shown', stop);
    // a voice swapped mid-sentence would finish the old one in the old voice
    window.addEventListener('climby:voice-changed', stop);
    window.addEventListener('climby:lang-changed', stop);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    window.addEventListener('pagehide', stop);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { attach, stop, textOf };
})();

window.Speak = Speak;
