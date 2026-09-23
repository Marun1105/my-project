// suggest.js — the tutor offering to put homework on the Route.
//
// "I've got maths for tomorrow" is a task the student is about to write out by
// hand, in an app that is already holding the list. The server hands back the
// task it heard, written the way a person would write it; this draws a card
// under the answer with one button.
//
// The card is a suggestion, not an action: nothing reaches the Route until it
// is pressed. And once pressed, the Undo in the toast is the same one the
// Route itself uses, so a mistaken tap costs a second.
const Suggest = (() => {
  // What is on offer right now, so a typed "yes" has something to mean. Only
  // ever the most recent answer's — an offer three messages old is not what
  // "yes" refers to.
  let pending = null;

  function clearPending() { pending = null; }

  // A short, local date. The Route stores YYYY-MM-DD; nobody reads that.
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((d - today) / 86400000);
    if (days === 0) return window.t ? t('suggest.today') : 'today';
    if (days === 1) return window.t ? t('suggest.tomorrow') : 'tomorrow';
    const lang = window.I18n ? I18n.get() : 'en';
    return d.toLocaleDateString(lang === 'bg' ? 'bg-BG' : 'en-GB', { day: 'numeric', month: 'short' });
  }

  function meta(task) {
    return [task.subject, when(task.deadline)].filter(Boolean).join(' · ');
  }

  // Put one on the Route. Shared by the button and by a typed "yes".
  async function accept(task, card) {
    if (!window.Checklist || !Checklist.addTask) return false;
    const btn = card && card.querySelector('.suggest-add');
    if (btn) btn.disabled = true;
    try {
      await Checklist.addTask(task.text, task.subject, task.deadline);
    } catch (err) {
      if (btn) btn.disabled = false;
      if (window.Toast) Toast.show(window.t ? t('suggest.failed') : 'Could not add it. Try again.');
      return false;
    }
    if (card) {
      card.classList.add('is-added');
      const action = card.querySelector('.suggest-action');
      if (action) {
        action.innerHTML = '';
        const done = document.createElement('span');
        done.className = 'suggest-done';
        done.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
        done.append(document.createTextNode(' ' + (window.t ? t('suggest.added') : 'On your Route')));
        action.appendChild(done);
      }
    }
    if (window.Toast) {
      Toast.show(window.t ? t('suggest.addedToast') : 'Added to your Route', {
        action: {
          label: window.t ? t('checklist.undo') : 'Undo',
          onClick: () => undo(task, card),
        },
      });
    }
    return true;
  }

  // Undo removes the task that was just made. Its id is not known here, so the
  // Route is asked for the newest one matching the text — which is the one
  // that was just added a second ago.
  async function undo(task, card) {
    if (!window.Checklist || !Checklist.removeNewestMatching) return;
    try {
      await Checklist.removeNewestMatching(task.text);
    } catch { /* leaving it on the Route is the safe way to fail */ }
    if (card) {
      card.classList.remove('is-added');
      draw(card, task);
    }
  }

  // The body of a card, drawn fresh so undo can put the button back.
  function draw(card, task) {
    card.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = 'suggest-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9 4.5h6M8 4.5H6.5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2H16"/>' +
      '<path d="M8.5 12.5 11 15l4.5-5"/></svg>';

    const text = document.createElement('span');
    text.className = 'suggest-text';
    const title = document.createElement('span');
    title.className = 'suggest-title';
    title.textContent = task.text;
    text.appendChild(title);
    const m = meta(task);
    if (m) {
      const sub = document.createElement('span');
      sub.className = 'suggest-meta';
      sub.textContent = m;
      text.appendChild(sub);
    }

    const action = document.createElement('span');
    action.className = 'suggest-action';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'suggest-add';
    add.textContent = window.t ? t('suggest.add') : 'Add to my Route';
    add.addEventListener('click', () => accept(task, card));
    action.appendChild(add);

    card.append(icon, text, action);
  }

  // Called by chat.js with whatever the server offered for this answer.
  function render(tasks, after) {
    clearPending();
    if (!Array.isArray(tasks) || !tasks.length) return;
    if (!window.Checklist || !Checklist.addTask) return;   // nothing to add to

    const wrap = document.createElement('div');
    wrap.className = 'suggest-list';
    const cards = [];
    for (const task of tasks) {
      const card = document.createElement('div');
      card.className = 'suggest-card';
      draw(card, task);
      wrap.appendChild(card);
      cards.push({ task, card });
    }
    after.appendChild(wrap);
    pending = cards;
  }

  // "yes" typed into the chat, rather than the button pressed. Matched here,
  // locally: sending it to the tutor would cost an answer to say "done".
  const YES = /^(yes|yeah|yep|yup|ok|okay|sure|please|do it|да|дa|добре|давай|хайде|може)[\s.!]*$/i;

  function looksLikeYes(text) {
    return YES.test((text || '').trim());
  }

  // Accept everything on offer. Returns how many went on.
  async function acceptPending() {
    if (!pending || !pending.length) return 0;
    const taking = pending;
    clearPending();
    let n = 0;
    for (const { task, card } of taking) {
      if (await accept(task, card)) n++;
    }
    return n;
  }

  function hasPending() { return !!(pending && pending.length); }

  return { render, looksLikeYes, acceptPending, hasPending, clearPending };
})();

window.Suggest = Suggest;
