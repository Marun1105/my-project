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

  // A voice for the app's language, if this machine has one. Voices load
  // asynchronously and the list can be empty on the first call.
  function voiceFor(code) {
    if (!synth) return null;
    const prefix = code.slice(0, 2).toLowerCase();
    return synth.getVoices().find(v => (v.lang || '').toLowerCase().startsWith(prefix)) || null;
  }

  // What gets read. Not innerText: KaTeX renders every formula twice — a hidden
  // MathML copy for assistive tech and the visible one — so innerText would
  // speak each equation twice. The badge is a logo, not content. Formulas
  // come out as their symbols: "x = 2" reads well, a stacked fraction reads
  // as its numbers in order. Honest limit; step-by-step playback is where to
  // do better than this.
  function textOf(el) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.katex-mathml, .ai-badge, .speak-btn').forEach(n => n.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function setSpeaking(on) {
    if (!button) return;
    button.classList.toggle('is-speaking', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', window.t ? t(on ? 'tutor.stopReading' : 'tutor.readAloud') : (on ? 'Stop' : 'Read aloud'));
    button.title = button.getAttribute('aria-label');
  }

  function stop() {
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    current = null;
    setSpeaking(false);
  }

  function start(el) {
    stop();
    const text = textOf(el);
    if (!text) return;
    const code = lang();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = code;
    const voice = voiceFor(code);
    if (voice) u.voice = voice;
    u.onend = u.onerror = () => { if (current === u) { current = null; setSpeaking(false); } };
    current = u;
    setSpeaking(true);
    synth.speak(u);
  }

  function toggle(el) {
    if (current) stop(); else start(el);
  }

  // Called by tutor.js after every render. The answer's HTML is rebuilt each
  // time, so the button is too; anything still speaking belongs to the old
  // answer and is cut off.
  function attach(el) {
    stop();
    if (!synth || !el) return;
    // No voice for this language on this machine: no button. A Bulgarian
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
  }

  function init() {
    if (!synth) return;
    // Voices arrive late; a button decided against before they load would be
    // wrong. Re-attach once they are known, if an answer is on screen.
    synth.addEventListener('voiceschanged', () => {
      const el = document.getElementById('answer');
      if (el && !el.classList.contains('hidden') && !el.querySelector('.speak-btn')) attach(el);
    });
    window.addEventListener('climby:view-shown', stop);
    window.addEventListener('climby:lang-changed', stop);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    window.addEventListener('pagehide', stop);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { attach, stop, textOf };
})();

window.Speak = Speak;
