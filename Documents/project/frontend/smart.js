// smart.js — the interactive cards ClimbAI can offer besides an answer:
//   • a TEST (multiple choice, instant coloured feedback, score ring, retry missed)
//   • FLASHCARDS (flip card, "I knew it" / "Not yet")
//   • a Study timer suggestion
// (A study plan reuses the Homework cards in suggest.js.)
//
// All of it is a suggestion, never an action: quizzes run locally and the timer
// card only opens the Study timer screen — it never starts the camera.
const Smart = (() => {
  const LETTERS = ['A', 'B', 'C', 'D'];
  const SVG = {
    quiz: '<path d="M9 9.5a3 3 0 1 1 4.2 2.75c-.8.4-1.2 1-1.2 1.75"/><path d="M12 17.5h.01"/><circle cx="12" cy="12" r="9"/>',
    cards: '<rect x="3.5" y="6" width="14" height="11" rx="2"/><path d="M7 3.5h12.5a1 1 0 0 1 1 1V14"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 3h5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  };

  function tr(key, vars, fallback) {
    return window.t ? t(key, vars) : fallback;
  }

  function icon(name) {
    const span = document.createElement('span');
    span.className = 'smart-icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + SVG[name] + '</svg>';
    return span;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, cls, onClick) {
    const b = el('button', 'smart-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // The score as a ring: nothing to read but the number and the arc.
  function ring(right, total) {
    const r = 34, c = 2 * Math.PI * r;
    const wrap = el('div', 'smart-ring');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', tr('smart.quizDone', { n: right, total }, `${right} of ${total}`));
    wrap.innerHTML =
      '<svg viewBox="0 0 80 80" aria-hidden="true"><circle class="smart-ring-bg" cx="40" cy="40" r="' + r + '"/>' +
      '<circle class="smart-ring-fg" cx="40" cy="40" r="' + r + '" stroke-dasharray="' + c.toFixed(1) +
      '" stroke-dashoffset="' + c.toFixed(1) + '" transform="rotate(-90 40 40)"/></svg>';
    const label = el('span', 'smart-ring-label');
    label.append(el('b', '', String(right)), el('span', '', '/' + total));
    wrap.appendChild(label);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const fg = wrap.querySelector('.smart-ring-fg');
      if (fg) fg.style.strokeDashoffset = String(c * (1 - (total ? right / total : 0)));
    }));
    return wrap;
  }

  function shell(kind, title, subject, count) {
    const box = el('section', 'smart-card smart-' + kind);
    box.setAttribute('aria-label', title);
    const head = el('header', 'smart-head');
    head.appendChild(icon(kind === 'cards' ? 'cards' : 'quiz'));
    const text = el('div', 'smart-head-text');
    text.append(el('span', 'smart-title', title));
    const kindLabel = kind === 'cards' ? tr('smart.flashcards', null, 'Flashcards') : tr('smart.test', null, 'Test');
    text.append(el('span', 'smart-meta', [kindLabel, subject, count + ' ' + tr('smart.questions', null, 'questions')]
      .filter(Boolean).join(' · ')));
    head.appendChild(text);
    const bar = el('div', 'smart-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'smart-bar-fill');
    bar.appendChild(fill);
    const body = el('div', 'smart-body');
    box.append(head, bar, body);
    return { box, body, fill };
  }

  function result(ui, run, cards, retry) {
    ui.fill.style.width = '100%';
    const total = cards.length;
    const right = total - run.missed.length;
    ui.body.innerHTML = '';
    const wrap = el('div', 'smart-result');
    const msg = right === total ? tr('smart.perfect', null, 'Perfect — you know this.')
      : right >= total / 2 ? tr('smart.good', null, 'Good work. A little more practice and it is yours.')
      : tr('smart.keepGoing', null, 'This one needs another go — that is how it sticks.');
    const text = el('div', 'smart-result-text');
    text.append(el('b', '', tr('smart.quizDone', { n: right, total }, `You got ${right} of ${total}.`)),
                el('span', '', msg));
    wrap.append(ring(right, total), text);
    const row = el('div', 'smart-row');
    if (run.missed.length) {
      row.append(button(tr('smart.retryMissed', { n: run.missed.length }, `Retry ${run.missed.length} missed`),
        '', () => retry(run.missed)));
    }
    row.append(button(tr('smart.again', null, 'Start over'), run.missed.length ? 'smart-btn--quiet' : '',
      () => retry(null)));
    ui.body.append(wrap, row);
    row.querySelector('button').focus();
  }

  function testQuestion(ui, run, cards, index, next) {
    const card = cards[index];
    ui.body.innerHTML = '';
    ui.fill.style.width = (index / cards.length * 100) + '%';
    ui.body.append(
      el('div', 'smart-count', tr('smart.progress', { n: index + 1, total: cards.length }, `${index + 1} / ${cards.length}`)),
      el('p', 'smart-q', card.q));
    const list = el('div', 'smart-options');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', tr('smart.options', null, 'Answers'));
    const feedback = el('div', 'smart-feedback hidden');
    feedback.setAttribute('role', 'status');
    let locked = false;

    card.options.forEach((option, i) => {
      const b = el('button', 'smart-option');
      b.type = 'button';
      b.append(el('span', 'smart-letter', LETTERS[i]), el('span', 'smart-option-text', option));
      b.addEventListener('click', () => {
        if (locked) return;
        locked = true;
        const ok = i === card.correct;
        if (!ok) run.missed.push(card);
        [...list.children].forEach((child, j) => {
          child.disabled = true;
          if (j === card.correct) child.classList.add('is-right');
          else if (j === i) child.classList.add('is-wrong');
          else child.classList.add('is-dim');
        });
        b.insertAdjacentHTML('beforeend', '<svg class="smart-mark" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          (ok ? SVG.check : SVG.cross) + '</svg>');
        feedback.classList.remove('hidden');
        feedback.classList.add(ok ? 'is-right' : 'is-wrong');
        feedback.append(
          el('b', '', ok ? tr('smart.right', null, 'Correct!') : tr('smart.wrong', null, 'Not quite.')),
          el('span', '', card.why || (ok ? '' : tr('smart.rightIs', { a: card.a }, `The answer is ${card.a}.`))));
        const last = index === cards.length - 1;
        const go = button(last ? tr('smart.finish', null, 'See my score') : tr('smart.next', null, 'Next question'),
          '', next);
        ui.body.appendChild(go);
        go.focus();
      });
      list.appendChild(b);
    });
    ui.body.append(list, feedback);
  }

  function flashQuestion(ui, run, cards, index, next) {
    const card = cards[index];
    ui.body.innerHTML = '';
    ui.fill.style.width = (index / cards.length * 100) + '%';
    ui.body.appendChild(el('div', 'smart-count',
      tr('smart.progress', { n: index + 1, total: cards.length }, `${index + 1} / ${cards.length}`)));

    const flip = el('button', 'smart-flip');
    flip.type = 'button';
    flip.setAttribute('aria-label', tr('smart.show', null, 'Show answer'));
    const inner = el('span', 'smart-flip-inner');
    const front = el('span', 'smart-flip-face smart-flip-front');
    front.append(el('span', 'smart-flip-tag', tr('smart.question', null, 'Question')), el('span', 'smart-flip-text', card.q),
      el('span', 'smart-flip-hint', tr('smart.tapToFlip', null, 'Tap to flip')));
    const back = el('span', 'smart-flip-face smart-flip-back');
    back.setAttribute('aria-hidden', 'true');
    back.append(el('span', 'smart-flip-tag', tr('smart.answer', null, 'Answer')), el('span', 'smart-flip-text', card.a));
    if (card.why) back.append(el('span', 'smart-flip-why', card.why));
    inner.append(front, back);
    flip.appendChild(inner);

    const row = el('div', 'smart-row hidden');
    row.append(
      button(tr('smart.knew', null, 'I knew it'), '', () => next()),
      button(tr('smart.missed', null, 'Not yet'), 'smart-btn--quiet', () => { run.missed.push(card); next(); }));

    flip.addEventListener('click', () => {
      const flipped = flip.classList.toggle('is-flipped');
      front.setAttribute('aria-hidden', String(flipped));
      back.setAttribute('aria-hidden', String(!flipped));
      flip.setAttribute('aria-label', flipped ? tr('smart.question', null, 'Question') : tr('smart.show', null, 'Show answer'));
      row.classList.toggle('hidden', !flipped);
    });
    ui.body.append(flip, row);
    flip.focus();
  }

  function quiz(data, after) {
    if (!data || !Array.isArray(data.cards) || !data.cards.length) return;
    const testMode = data.cards.every(c => Array.isArray(c.options) && c.options.length >= 2);
    const title = data.title || (testMode ? tr('smart.quiz', null, 'Quick quiz') : tr('smart.flashcards', null, 'Flashcards'));
    const ui = shell(testMode ? 'test' : 'cards', title, data.subject, data.cards.length);

    function start(cards) {
      const run = { missed: [] };
      let index = 0;
      const step = () => {
        if (index >= cards.length) {
          result(ui, run, cards, again => start(again || data.cards));
          return;
        }
        const i = index++;
        (testMode ? testQuestion : flashQuestion)(ui, run, cards, i, step);
      };
      step();
    }
    start(data.cards);
    after.appendChild(ui.box);
  }

  function timer(data, after) {
    if (!data || !data.minutes) return;
    const box = el('section', 'smart-card smart-timer');
    const dial = el('div', 'smart-dial');
    dial.setAttribute('aria-hidden', 'true');
    dial.append(icon('timer'), el('b', '', String(data.minutes)), el('span', '', tr('smart.min', null, 'min')));
    const text = el('div', 'smart-timer-text');
    text.append(el('span', 'smart-title', tr('smart.timerTitle', { n: data.minutes }, `${data.minutes} min of focused work`)));
    if (data.label) text.append(el('span', 'smart-meta', data.label));
    const open = button(tr('smart.openTimer', null, 'Open Study timer'), '', () => {
      if (window.Nav && Nav.activate) Nav.activate('focus');
      const closeBtn = document.getElementById('chatClose');
      if (closeBtn) closeBtn.click();
    });
    box.append(dial, text, open);
    after.appendChild(box);
  }

  // Everything the server offered besides the answer itself.
  function render(data, after) {
    if (!data) return;
    quiz(data.quiz, after);
    timer(data.timer, after);
  }

  return { render };
})();

window.Smart = Smart;
