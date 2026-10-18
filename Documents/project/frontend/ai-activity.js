// ai-activity.js — what ClimbAI looks like while it works.
//
// Two short loops stand for ClimbAI everywhere it makes someone wait: the bird
// ("thinking") and the ring ("reading"). Beside the loop sits a status line in
// the manner of ChatGPT, Claude and Gemini: a shimmering phrase that says what
// ClimbAI is doing, and a quiet seconds counter. When the answer arrives it can
// be signed "Thought for 9 s".
//
// Honest by construction: the server does not stream its progress, so the
// phrases advance on the times measured for each kind of request, and the last
// one holds until the answer is there — it never claims to be finished.
//
// The poster is the still frame and stays visible when autoplay is blocked or
// when the person has asked their system for less motion; then the phrases
// still change, but nothing shimmers or moves.
const AIActivity = (() => {
  const MEDIA = {
    thinking: {
      video: 'media/climbai-thinking.webm',
      poster: 'media/climbai-thinking-poster.jpg',
    },
    reading: {
      video: 'media/climbai-reading.webm',
      poster: 'media/climbai-reading-poster.jpg',
    },
  };

  // [i18n key, ms after the start]. 'think.write' becomes a hint or a solution
  // depending on how the person asked ClimbAI to explain (Settings → ClimbAI).
  const PHASES = {
    chat: [['think.chat1', 0], ['think.chat2', 2200], ['think.chat3', 5500], ['think.write', 9500], ['think.long', 22000]],
    followup: [['think.follow1', 0], ['think.follow2', 2200], ['think.follow3', 5500], ['think.write', 9500], ['think.long', 22000]],
    plan: [['think.plan1', 0], ['think.plan2', 2500], ['think.plan3', 6000], ['think.plan4', 10000], ['think.long', 22000]],
    split: [['think.split1', 0], ['think.split2', 2500], ['think.split3', 6000], ['think.long', 18000]],
  };

  const t = (key, vars) => (window.I18n ? I18n.t(key, vars) : key);
  // Less motion when the system asks for it, or when the person turned the app's
  // own animations off (Settings → Appearance: Animations off, or calm).
  const calm = () => {
    const motion = document.documentElement.getAttribute('data-motion');
    if (motion === 'off' || motion === 'calm') return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  };

  function phrase(key) {
    if (key !== 'think.write') return t(key);
    const mode = window.Prefs ? Prefs.get('tutor') : 'hints';
    return t(mode === 'full' ? 'think.writeFull' : 'think.writeHint');
  }

  // A loop plays only while it can be seen. Hidden ones (a closed notice, a
  // stage not shown yet) sit paused instead of decoding video for nobody.
  const watcher = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => entries.forEach(entry => {
        const video = entry.target.querySelector('video');
        if (!video) return;
        if (entry.isIntersecting) video.play().catch(() => { /* the poster stays */ });
        else video.pause();
      }))
    : null;

  // The black tile with the loop in it. Used inside the status line, and on its
  // own by anything marked data-ai-loop="thinking|reading" in the page.
  function artwork(kind, tile) {
    const media = MEDIA[kind];
    if (!media) throw new TypeError(`Unknown ClimbAI activity: ${kind}`);
    const art = tile || document.createElement('span');
    art.classList.add('ai-activity-artwork');
    art.setAttribute('aria-hidden', 'true');

    // data-ai-keep: what is already inside the tile is the still frame (the
    // splash keeps the Climby mountain until the ring is moving)
    if (!('aiKeep' in art.dataset)) {
      const poster = document.createElement('img');
      poster.className = 'ai-activity-poster';
      poster.src = media.poster;
      poster.alt = '';
      art.appendChild(poster);
    }

    if (!calm()) {
      const video = document.createElement('video');
      video.className = 'ai-activity-video';
      video.src = media.video;
      video.poster = media.poster;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('aria-hidden', 'true');
      video.addEventListener('playing', () => art.classList.add('is-playing'), { once: true });
      art.appendChild(video);
      if (watcher) watcher.observe(art);
      else video.play().catch(() => { /* the poster stays */ });
    }
    return art;
  }

  // create(kind, label, compact, { phases, timer })
  //   phases: a name from PHASES — the label then walks through those phrases
  //   timer:  show the seconds counter (on by default when there are phases)
  function create(kind, label, compact = false, options = {}) {
    const steps = options.phases ? PHASES[options.phases] : null;
    const showTimer = options.timer ?? !!steps;

    const activity = document.createElement('div');
    // compact: the chat bubble; 'tiny': inside a button or a line of text
    activity.className = 'ai-activity'
      + (compact === 'tiny' ? ' ai-activity--tiny' : compact ? ' ai-activity--compact' : '');
    activity.dataset.startedAt = String(Date.now());

    const text = document.createElement('span');
    text.className = 'ai-activity-text';

    const line = document.createElement('span');
    // The answer card or chat bubble around this is already a polite live
    // region, so the changing phrase is read out without a second one here.
    line.className = 'ai-activity-label ai-shimmer';
    line.textContent = steps ? phrase(steps[0][0]) : label;
    text.appendChild(line);

    let clock = null;
    if (showTimer) {
      clock = document.createElement('span');
      clock.className = 'ai-activity-time';
      clock.setAttribute('aria-hidden', 'true');
      text.appendChild(clock);
    }

    activity.append(artwork(kind), text);

    // One timer drives both the phrase and the counter, and stops by itself
    // once the element has left the page: callers just replace it.
    const started = Date.now();
    let shown = 0;
    let attached = false;
    const tick = () => {
      if (!activity.isConnected) {
        if (attached) { clearInterval(timer); return; }
        return;
      }
      attached = true;
      const elapsed = Date.now() - started;
      if (clock) {
        const s = Math.floor(elapsed / 1000);
        clock.textContent = s >= 1 ? t('think.seconds', { s }) : '';
      }
      if (steps) {
        let next = shown;
        while (next + 1 < steps.length && elapsed >= steps[next + 1][1]) next++;
        if (next !== shown) {
          shown = next;
          swap(line, phrase(steps[next][0]));
        }
      }
    };
    const timer = setInterval(tick, 250);
    // Never attached within a minute means the caller dropped it; stop anyway.
    setTimeout(() => { if (!attached) clearInterval(timer); }, 60000);
    return activity;
  }

  // The phrase fades out, changes and fades back in; with less motion it
  // simply changes.
  function swap(line, next) {
    if (calm()) { line.textContent = next; return; }
    line.classList.add('is-leaving');
    setTimeout(() => {
      line.textContent = next;
      line.classList.remove('is-leaving');
    }, 180);
  }

  // How long a status line has been up, in whole seconds (at least 1).
  function seconds(el) {
    const node = el && (el.matches?.('.ai-activity') ? el : el.querySelector?.('.ai-activity'));
    const at = node ? Number(node.dataset.startedAt) : 0;
    return at ? Math.max(1, Math.round((Date.now() - at) / 1000)) : 0;
  }

  // "Thought for 9 s" — the small signature over a finished answer.
  function thought(secs) {
    const el = document.createElement('span');
    el.className = 'ai-thought';
    el.textContent = t('think.thoughtFor', { s: secs });
    return el;
  }

  // Puts the signature into an answer that has just been drawn: after the
  // ClimbAI badge when there is one, otherwise at the very top.
  function sign(answerEl, secs) {
    if (!answerEl || !secs) return;
    const mark = thought(secs);
    const badge = answerEl.querySelector(':scope > .ai-badge');
    if (badge) badge.after(mark);
    else { mark.classList.add('ai-thought--block'); answerEl.prepend(mark); }
  }

  // An ordinary wait (a list, a paper) inside an empty-state title or a status
  // line: the small ring and the words. The next setEmptyText() or
  // textContent = … replaces it, so there is nothing to undo.
  function fillLoading(el, text) {
    if (!el) return;
    const target = el.querySelector('.empty-title') || el;
    const row = document.createElement('span');
    row.className = 'ai-inline';
    row.append(artwork('reading'));
    const words = document.createElement('span');
    words.className = 'ai-shimmer';
    words.textContent = text;
    row.append(words);
    target.replaceChildren(row);
  }

  // Loops written straight into the page: <span data-ai-loop="reading"></span>
  function hydrate(root = document) {
    root.querySelectorAll('[data-ai-loop]:not(.ai-activity-artwork)').forEach(tile => {
      artwork(tile.dataset.aiLoop, tile);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate());
  else hydrate();

  return { create, seconds, sign, thought, fillLoading, hydrate };
})();

window.AIActivity = AIActivity;
