// Keep long AI waits inside their answer. Only show this non-blocking notice
// when a sleeping backend is actually waking up.
const Loading = (() => {
  const SHOW_DELAY_MS = 350;
  const MIN_VISIBLE_MS = 700;
  const active = new Map();
  let nextId = 0;
  let showTimer = null;
  let hideTimer = null;
  let shownAt = 0;

  const t = (key, vars) => window.t ? window.t(key, vars) : key;
  const notice = () => document.getElementById('netWakeStatus');
  const message = () => document.getElementById('netWakeMessage');

  function render() {
    const el = notice();
    const text = message();
    if (!el || !text) return;
    const latest = [...active.values()].filter(item => item.visible).at(-1);
    if (!latest) return;
    text.textContent = t(latest.key, latest.vars);
  }

  function reveal() {
    showTimer = null;
    if (![...active.values()].some(item => item.visible)) return;
    const el = notice();
    if (!el) return;
    render();
    el.classList.remove('hidden');
    shownAt = Date.now();
  }

  function hideWhenIdle() {
    if ([...active.values()].some(item => item.visible)) {
      clearTimeout(hideTimer);
      hideTimer = null;
      render();
      return;
    }
    clearTimeout(showTimer);
    showTimer = null;
    const el = notice();
    if (!el || el.classList.contains('hidden') || hideTimer !== null) return;
    const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt));
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (![...active.values()].some(item => item.visible)) el.classList.add('hidden');
    }, wait);
  }

  function begin(key = 'loading.generic', vars = null) {
    const id = ++nextId;
    active.set(id, { key, vars, visible: false });
    return {
      update(nextKey, nextVars = null) {
        if (!active.has(id)) return;
        const visible = nextKey === 'net.waking';
        active.set(id, { key: nextKey, vars: nextVars, visible });
        if (visible) {
          clearTimeout(hideTimer);
          hideTimer = null;
          if (showTimer === null && notice()?.classList.contains('hidden')) {
            showTimer = setTimeout(reveal, SHOW_DELAY_MS);
          } else {
            render();
          }
        } else {
          hideWhenIdle();
        }
      },
      end() {
        if (!active.delete(id)) return;
        hideWhenIdle();
      },
    };
  }

  window.addEventListener('climby:lang-changed', render);
  return { begin };
})();

window.Loading = Loading;
