// Memory is a per-account, on-device selection. Only selected categories are
// sent with signed-in ClimbAI requests; personal notes never sync to Climby.
const Memory = (() => {
  const PREFIX = 'climby-memory-v1:';
  let storageError = false;
  const defaults = () => ({
    learning_level: false,
    checklist: false,
    focus_sessions: false,
    previous_questions: false,
    personal_enabled: false,
    personal_note: '',
  });

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
        learning_level: saved.learning_level === true,
        checklist: saved.checklist === true,
        focus_sessions: saved.focus_sessions === true,
        previous_questions: saved.previous_questions === true,
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

  function isEnabled() {
    const value = read();
    return !!(value.learning_level || value.checklist || value.focus_sessions || value.previous_questions ||
      (value.personal_enabled && value.personal_note.trim()));
  }

  function request() {
    const value = read();
    return {
      learning_level: value.learning_level,
      checklist: value.checklist,
      focus_sessions: value.focus_sessions,
      previous_questions: value.previous_questions,
      personal_note_enabled: value.personal_enabled,
      personal_note: value.personal_enabled ? value.personal_note.trim().slice(0, 600) : '',
    };
  }

  function render() {
    const value = read();
    const signedIn = !!(window.Auth && Auth.isLoggedIn());
    const checkboxMap = {
      memoryGrade: 'learning_level',
      memoryChecklist: 'checklist',
      memoryFocus: 'focus_sessions',
      memoryQuestions: 'previous_questions',
      memoryPersonal: 'personal_enabled',
    };
    Object.entries(checkboxMap).forEach(([id, field]) => {
      const input = document.getElementById(id);
      if (input) {
        input.checked = value[field];
        input.disabled = !signedIn;
      }
    });
    const note = document.getElementById('memoryPersonalNote');
    if (note) {
      if (note.value !== value.personal_note) note.value = value.personal_note;
      note.disabled = !signedIn || !value.personal_enabled;
    }
    const loginHint = document.getElementById('memoryLoginHint');
    if (loginHint) loginHint.classList.toggle('hidden', signedIn);
    const storageNotice = document.getElementById('memoryStorageError');
    if (storageNotice) storageNotice.classList.toggle('hidden', !storageError);
    const status = document.getElementById('chatMemoryStatus');
    if (status) {
      const active = signedIn && isEnabled();
      status.textContent = window.t
        ? t(active ? 'memory.chatOn' : 'memory.chatOff')
        : '';
      status.classList.toggle('is-active', active);
    }
  }

  function bind() {
    const checkboxMap = {
      memoryGrade: 'learning_level',
      memoryChecklist: 'checklist',
      memoryFocus: 'focus_sessions',
      memoryQuestions: 'previous_questions',
      memoryPersonal: 'personal_enabled',
    };
    Object.entries(checkboxMap).forEach(([id, field]) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('change', () => {
        const value = read();
        value[field] = input.checked;
        write(value);
      });
    });
    const note = document.getElementById('memoryPersonalNote');
    if (note) note.addEventListener('input', () => {
      const value = read();
      value.personal_note = note.value.slice(0, 600);
      write(value);
    });
    const clear = document.getElementById('memoryClear');
    if (clear) clear.addEventListener('click', () => write(defaults()));
    window.addEventListener('climby:auth-changed', render);
    window.addEventListener('climby:lang-changed', render);
    render();
  }

  document.addEventListener('DOMContentLoaded', bind);
  return { request, isEnabled, render };
})();

window.Memory = Memory;
