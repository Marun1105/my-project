// copy.js — copy an answer with one click.
//
// Every app with text worth keeping has this. The tutor's answer goes into a
// notebook, a message to a friend, a search — and selecting five paragraphs
// of rendered maths by hand is how you lose half of them. Copies the plain
// text; the button says "Copied" for a moment and goes back.
const Copy = (() => {
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  function textOf(el) {
    // the buttons are inside the answer; leave them out of what is copied
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, .katex-mathml').forEach(n => n.remove());
    return clone.innerText.trim();
  }

  function attach(el) {
    if (!el || !navigator.clipboard || el.querySelector('.copy-btn')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-btn';
    b.setAttribute('aria-label', window.t ? t('answer.copy') : 'Copy answer');
    b.innerHTML = ICON;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textOf(el));
        b.innerHTML = DONE;
        b.classList.add('is-done');
        b.setAttribute('aria-label', window.t ? t('answer.copied') : 'Copied');
        setTimeout(() => { b.innerHTML = ICON; b.classList.remove('is-done'); b.setAttribute('aria-label', window.t ? t('answer.copy') : 'Copy answer'); }, 1600);
      } catch { /* clipboard refused: nothing to say that the missing tick doesn't */ }
    });
    el.insertBefore(b, el.firstChild);
  }

  return { attach };
})();

window.Copy = Copy;
