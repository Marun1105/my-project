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
