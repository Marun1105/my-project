// copy.js — copy an answer with one click.
//
// Every app with text worth keeping has this. The tutor's answer goes into a
// notebook, a message to a friend, a search — and selecting five paragraphs
// of rendered maths by hand is how you lose half of them. Copies the plain
// text; the button says "Copied" for a moment and goes back.
const Copy = (() => {
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  // What lands on the clipboard. `innerText` on a detached clone is not the
  // rendered text — the node was never laid out, so it quietly falls back to
  // textContent and a four-step answer arrives as one run-on line wearing the
  // HTML source's indentation. So the blocks are walked for their own line
  // breaks, and the runs of whitespace inside each one are collapsed.
  //
  // KaTeX renders every formula twice, a hidden MathML copy and the visible
  // one; speak.js drops the same node for the same reason.
  const BLOCKS = 'p, div, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, br';

  function textOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, .katex-mathml, .ai-badge').forEach(n => n.remove());
    // a marker no answer can contain, swapped for newlines once flattened
    clone.querySelectorAll(BLOCKS).forEach(n => n.insertAdjacentText('beforebegin', '\u0000'));
    clone.querySelectorAll('li').forEach(n => n.insertAdjacentText('afterbegin', '\u2022 '));
    return (clone.textContent || '')
      .split('\u0000')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
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
