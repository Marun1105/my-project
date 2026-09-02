// help.js — помощта се вика, а не се търпи.
//
// Всеки екран имаше отгоре сиво блокче "как работи това". На първия ден е
// полезно. На тридесетия е нещо, което подминаваш всеки път, за да стигнеш до
// работата си — и е първото, което очите се научават да не виждат.
//
// Сега обяснението стои зад копче „?" до заглавието. Показва се само на човек,
// който още не го е чел: първия път се отваря само, а щом го затвориш, повече
// не се обажда. Изборът се помни за всеки екран поотделно, защото „разбрах
// чеклиста" не значи „разбрах фокус камерата".
const Help = (() => {
  const KEY = 'climby-help-seen';

  function seen() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      return {}; // повреден запис не бива да чупи екрана — просто почваме отначало
    }
  }

  function remember(view, isSeen) {
    const all = seen();
    all[view] = !!isSeen;
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch { /* без запис също върви, само няма да се помни */ }
  }

  function notesFor(view) {
    const root = document.getElementById('view-' + view);
    return root ? [...root.querySelectorAll('.help-note')] : [];
  }

  function setOpen(view, open) {
    notesFor(view).forEach(note => note.classList.toggle('hidden', !open));
    const btn = document.querySelector(`.help-toggle[data-help-view="${view}"]`);
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('is-open', open);
    }
  }

  function toggle(view) {
    const btn = document.querySelector(`.help-toggle[data-help-view="${view}"]`);
    const open = btn ? btn.getAttribute('aria-expanded') !== 'true' : true;
    setOpen(view, open);
    // Отвори ли го веднъж и го затвори, значи го е прочел. Затваряме темата.
    if (!open) remember(view, true);
  }

  function init() {
    const already = seen();
    document.querySelectorAll('.help-toggle').forEach(btn => {
      const view = btn.dataset.helpView;
      // Първото идване: обяснението стои отворено, за да го види човекът, който
      // още не знае какво гледа.
      setOpen(view, !already[view]);
      btn.addEventListener('click', () => toggle(view));
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { setOpen, toggle };
})();

window.Help = Help;
