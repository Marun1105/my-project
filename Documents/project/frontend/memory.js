// ClimbAI memory: one switch, on unless the person turns it off.
//
// It used to be five separate opt-in boxes, all off, and nobody could tell what
// ticking "Earlier ClimbAI questions" would change. Now ClimbAI simply
// remembers — the grade, the unfinished homework, recent focus time and a few
// recent questions — so it never starts from zero, and one switch turns all of
// it off. A note the person writes is extra, behind its own box.
//
// The choice and the note are kept per account, on this device. The server
// still receives the same per-category flags it always did.
const Memory = (() => {
  const PREFIX = 'climby-memory-v1:';
  let storageError = false;
  const defaults = () => ({ on: true, personal_enabled: false, personal_note: '' });

  function owner() {
    const user = window.Auth && Auth.getUser();
    return user && user.id ? String(user.id) : 'guest';
  }

  function key() { return PREFIX + encodeURIComponent(owner()); }

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(key()) || 'null');
      if (!saved || typeof saved !== 'object') return defaults();
      return {
        // A record from before the switch (per-category boxes) has no 'on':
        // it stays off unless the person had ticked something. Only someone
        // with no record at all starts with memory on.
        on: 'on' in saved
          ? saved.on !== false
          : !!(saved.learning_level || saved.checklist || saved.focus_sessions || saved.previous_questions),
        personal_enabled: saved.personal_enabled === true,
        personal_note: typeof saved.personal_note === 'string' ? saved.personal_note.slice(0, 600) : '',
      };
    } catch {
      storageError = true;
      return defaults();
    }
  }

  function write(value) {
    try {
      localStorage.setItem(key(), JSON.stringify(value));
      storageError = false;
    } catch {
      storageError = true;
    }
    render();
    window.dispatchEvent(new CustomEvent('climby:memory-changed'));
  }

  function isEnabled() { return read().on; }

  function request() {
    const value = read();
    const on = value.on;
    const note = on && value.personal_enabled ? value.personal_note.trim().slice(0, 600) : '';
    return {
      learning_level: on,
      checklist: on,
      focus_sessions: on,
      previous_questions: on,
      personal_note_enabled: !!note,
      personal_note: note,
    };
  }

  function render() {
    const value = read();
    const signedIn = !!(window.Auth && Auth.isLoggedIn());
    const sw = document.getElementById('memoryOn');
    if (sw) {
      sw.checked = signedIn && value.on;
      sw.disabled = !signedIn;
    }
    const box = document.getElementById('memoryPersonal');
    if (box) {
      box.checked = value.personal_enabled;
      box.disabled = !signedIn || !value.on;
    }
    const note = document.getElementById('memoryPersonalNote');
    if (note) {
      if (note.value !== value.personal_note) note.value = value.personal_note;
      // the box to write in appears only once the person has asked for it
      note.classList.toggle('hidden', !(signedIn && value.on && value.personal_enabled));
    }
    const row = document.querySelector('.memory-note-row');
    if (row) row.classList.toggle('is-off', !(signedIn && value.on));
    const loginHint = document.getElementById('memoryLoginHint');
    if (loginHint) loginHint.classList.toggle('hidden', signedIn);
    const storageNotice = document.getElementById('memoryStorageError');
    if (storageNotice) storageNotice.classList.toggle('hidden', !storageError);
    const status = document.getElementById('chatMemoryStatus');
    if (status) {
      const active = signedIn && value.on;
      status.textContent = window.t ? t(active ? 'memory.chatOn' : 'memory.chatOff') : '';
      status.classList.toggle('is-active', active);
    }
  }

  function bind() {
    const sw = document.getElementById('memoryOn');
    if (sw) sw.addEventListener('change', () => {
      const value = read();
      value.on = sw.checked;
      write(value);
    });
    const box = document.getElementById('memoryPersonal');
    if (box) box.addEventListener('change', () => {
      const value = read();
      value.personal_enabled = box.checked;
      write(value);
      if (box.checked) document.getElementById('memoryPersonalNote')?.focus();
    });
    const note = document.getElementById('memoryPersonalNote');
    if (note) note.addEventListener('input', () => {
      const value = read();
      value.personal_note = note.value.slice(0, 600);
      write(value);
    });
    window.addEventListener('climby:auth-changed', render);
    window.addEventListener('climby:lang-changed', render);
    render();
  }

  document.addEventListener('DOMContentLoaded', bind);
  return { request, isEnabled, render };
})();

window.Memory = Memory;
