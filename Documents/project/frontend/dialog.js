// dialog.js — keep the keyboard inside an open panel, and give it back after.
//
// Settings, the questions, the chat panel and the entry gate all open on top of
// the app. Until now Tab walked straight out of them and down the page
// underneath: a keyboard user pressing Tab in Settings ended up moving through
// the sidebar behind it, with no way to tell where they were. And when a panel
// closed, focus fell back to the top of the document rather than to the button
// that opened it.
//
// Nothing at the call sites changes. The panels all announce themselves the
// same way — they drop the `hidden` class — so one observer is enough.
(() => {
  const PANELS = '.settings-overlay, .chat-panel, .onboarding, #entryGate';
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // what had focus before each panel opened, so it can be handed back
  const cameFrom = new WeakMap();

  const visible = el => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  const stops = panel => [...panel.querySelectorAll(FOCUSABLE)].filter(visible);

  function onKey(e) {
    if (e.key !== 'Tab') return;
    const panel = e.currentTarget;
    const items = stops(panel);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    // Tab off the end comes back to the start, and Shift+Tab off the start
    // goes to the end — the loop is what makes it a trap rather than a leak.
    if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function opened(panel) {
    if (panel.dataset.trapped === '1') return;
    panel.dataset.trapped = '1';
    cameFrom.set(panel, document.activeElement);
    panel.addEventListener('keydown', onKey);
    // A panel announced as a dialog is read as one; without this a screen
    // reader carries on through the page behind it.
    if (!panel.getAttribute('role')) panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    // The close button is a poor landing place — it reads as "leave". The first
    // real control is where the panel actually starts.
    const items = stops(panel);
    const target = items.find(el => !/close/i.test(el.className) && !/close/i.test(el.id)) || items[0];
    if (target) setTimeout(() => target.focus(), 30);
  }

  function closed(panel) {
    if (panel.dataset.trapped !== '1') return;
    panel.dataset.trapped = '';
    panel.removeEventListener('keydown', onKey);
    panel.removeAttribute('aria-modal');
    const back = cameFrom.get(panel);
    cameFrom.delete(panel);
    if (back && back !== document.body && document.contains(back) && visible(back)) back.focus();
  }

  function watch(panel) {
    const sync = () => (panel.classList.contains('hidden') ? closed(panel) : opened(panel));
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll(PANELS).forEach(watch);
  });
})();

// An inline "are you sure?" that grows where the button was. The browser's
// confirm() stops the whole page and looks like a foreign window — easy to
// click through blind. This says what will be lost, is undone with Escape or
// "No", and lands focus on the safe answer so a stray Enter deletes nothing.
// Classes used it first; the family screen needs the same thing for revoking
// a parent's access, so it lives here now.
window.InlineConfirm = (() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // anchor: the bar goes after it. trigger: the button that opens it, hidden
  // while the question is up. onYes: returns a promise.
  function wire(anchor, trigger, question, why, onYes) {
    let bar = null;

    function close() {
      if (!bar) return;
      bar.remove();
      bar = null;
      trigger.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    }

    function open() {
      if (bar) return;
      bar = el('div', 'cls-confirm');
      bar.setAttribute('role', 'group');
      const text = el('div', 'cls-confirm-text');
      text.appendChild(el('strong', 'cls-confirm-question', question));
      if (why) text.appendChild(el('span', 'cls-confirm-why', why));
      const actions = el('div', 'cls-confirm-actions');
      const yes = el('button', 'cls-btn cls-btn-solid', t('classes.confirmYes'));
      yes.type = 'button';
      const no = el('button', 'cls-btn', t('classes.confirmNo'));
      no.type = 'button';
      yes.addEventListener('click', () => Net.guardClick(yes, onYes));
      no.addEventListener('click', close);
      bar.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
      actions.append(no, yes);
      bar.append(text, actions);
      anchor.insertAdjacentElement('afterend', bar);
      trigger.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'true');
      no.focus();
    }

    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', open);
  }

  return { wire };
})();
