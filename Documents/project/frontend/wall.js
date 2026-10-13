// wall.js — Стената: клибите, обвръзката и класацията.
//
// Нито едно число тук не идва от браузъра. Клибите се печелят на сървъра, в
// трите места, където работата се записва (clibis.py), и този файл само ги
// показва — иначе щеше да има сметка, която ученикът може да поправи сам.
//
// Класацията започва от приятелите нарочно. Общ списък с деца, подреден по
// число, слага повечето от тях към дъното; това е екранът, който трябва да
// кара човек да се върне, а не да му казва, че е последен.
const Wall = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;

  let scope = 'friends';
  let loaded = false;

  async function api(path, options = {}) {
    const token = Auth.getToken();
    let res;
    try {
      res = await Net.fetch(BACKEND + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new Error(t('wall.errOffline'));
    }
    if (res.status === 401) {
      Auth.logout();
      throw new Error(t('wall.errSession'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data && data.detail;
      throw new Error(typeof detail === 'string' && detail ? detail : t('wall.errGeneric'));
    }
    return data;
  }

  function _el(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function _showError(err) {
    const el = $('wallError');
    el.textContent = (err && err.message) || t('wall.errGeneric');
    el.classList.remove('hidden');
  }

  function _clearError() { $('wallError').classList.add('hidden'); }

  // ---------- кесията ----------

  async function _drawPurse() {
    const me = await api('/clibis/me');
    $('wallClibis').textContent = me.balance;
    $('wallToday').textContent = t('wall.today', { n: me.earned_today, cap: me.daily_cap });
    const profile = await api('/social/me');
    $('wallCode').textContent = profile.friend_code;
    return profile;
  }

  // ---------- обвръзката ----------

  function _ropeCard(rope) {
    const box = _el('div', 'rope-card');
    if (!rope || !rope.rope) {
      box.appendChild(_el('p', 'wall-empty', t('wall.noRope')));
      return box;
    }
    box.appendChild(_el('div', 'rope-who', t('wall.ropeWith', { name: rope.partner })));

    const bar = (label, value) => {
      const row = _el('div', 'rope-row');
      row.appendChild(_el('span', 'rope-name', label));
      const track = _el('div', 'rope-track');
      const fill = _el('div', 'rope-fill');
      // Пълнотата е изрязана на 100%, защото лентата показва целта, а не
      // рекорда: над нея няма какво повече да се покаже.
      fill.style.width = Math.min(100, Math.round((value / rope.target) * 100)) + '%';
      if (value >= rope.target) fill.classList.add('done');
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(_el('span', 'rope-num', `${value}/${rope.target}`));
      return row;
    };

    box.appendChild(bar(t('wall.you'), rope.mine));
    box.appendChild(bar(rope.partner || '', rope.theirs));

    if (rope.settled) {
      const won = rope.mine >= rope.target && rope.theirs >= rope.target;
      box.appendChild(_el('p', 'wall-note', t(won ? 'wall.ropeWon' : 'wall.ropeMissed')));
    }
    return box;
  }

  // ---------- приятелите ----------

  function _friendRow(f) {
    const row = _el('div', 'friend-row');
    const left = _el('div', 'friend-who');
    left.appendChild(_el('span', 'friend-name', f.name));
    if (f.grade) left.appendChild(_el('span', 'friend-grade', t('wall.grade', { n: f.grade })));
    row.appendChild(left);

    const nums = _el('div', 'friend-nums');
    nums.appendChild(_el('span', 'friend-clibis', `${f.clibis} ${t('wall.clibisShort')}`));
    nums.appendChild(_el('span', 'friend-solved', t('wall.solved', { n: f.solved })));
    row.appendChild(nums);

    const tie = _el('button', 'btn-ghost wall-mini', t('wall.tieIn'));
    tie.addEventListener('click', () => _tieIn(f.user_id));
    row.appendChild(tie);

    const drop = _el('button', 'btn-ghost wall-mini', t('wall.remove'));
    drop.addEventListener('click', () => _remove(f.link_id));
    row.appendChild(drop);
    return row;
  }

  function _pendingRow(p) {
    const row = _el('div', 'friend-row pending');
    // Поканата, която аз съм пратил, няма име: докато другият не приеме,
    // сървърът не го казва (виж social.list_friends). Пишем какво чака, не кой.
    row.appendChild(_el('span', 'friend-name', p.they_asked ? p.name : t('wall.youAsked')));
    if (p.they_asked) {
      const ok = _el('button', 'btn-secondary wall-mini', t('wall.accept'));
      ok.addEventListener('click', () => _accept(p.link_id));
      row.appendChild(ok);
    } else {
      row.appendChild(_el('span', 'wall-note', t('wall.waiting')));
    }
    return row;
  }

  // ---------- класацията ----------

  function _boardRows(rows) {
    const box = _el('div', 'board');
    if (!rows.length) {
      box.appendChild(_el('p', 'wall-empty', t('wall.boardEmpty')));
      return box;
    }
    rows.forEach(r => {
      const row = _el('div', 'board-row' + (r.you ? ' you' : ''));
      row.appendChild(_el('span', 'board-place', r.place));
      row.appendChild(_el('span', 'board-name', r.name || '—'));
      row.appendChild(_el('span', 'board-clibis', r.clibis));
      box.appendChild(row);
    });
    return box;
  }

  function _globalInvite() {
    const box = _el('div', 'wall-invite');
    box.appendChild(_el('p', 'wall-note', t('wall.globalWhy')));
    const field = _el('div', 'wall-add');
    const input = _el('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = t('wall.nickname');
    field.appendChild(input);
    const go = _el('button', 'btn-secondary', t('wall.joinGlobal'));
    go.addEventListener('click', async () => {
      const nickname = input.value.trim();
      if (!nickname) return;
      try {
        _clearError();
        await api('/social/global-board', { method: 'POST', body: JSON.stringify({ nickname }) });
        await refresh();
      } catch (err) { _showError(err); }
    });
    field.appendChild(go);
    box.appendChild(field);
    return box;
  }

  // ---------- действия ----------

  async function _add() {
    const code = $('wallFriendCode').value.trim().toUpperCase();
    if (!code) return;
    try {
      _clearError();
      await api('/social/friends/code/' + encodeURIComponent(code), { method: 'POST' });
      $('wallFriendCode').value = '';
      await refresh();
    } catch (err) { _showError(err); }
  }

  async function _accept(linkId) {
    try {
      _clearError();
      await api(`/social/friends/${linkId}/accept`, { method: 'POST' });
      await refresh();
    } catch (err) { _showError(err); }
  }

  async function _remove(linkId) {
    try {
      _clearError();
      await api(`/social/friends/${linkId}`, { method: 'DELETE' });
      await refresh();
    } catch (err) { _showError(err); }
  }

  async function _tieIn(friendId) {
    try {
      _clearError();
      await api('/social/rope/' + encodeURIComponent(friendId), {
        method: 'POST',
        body: JSON.stringify({ target: 150 }),
      });
      await refresh();
    } catch (err) { _showError(err); }
  }

  // ---------- рисуване ----------

  async function refresh() {
    if (!Auth.isLoggedIn()) return;
    try {
      _clearError();
      const profile = await _drawPurse();

      const rope = await api('/social/rope');
      const ropeBox = $('wallRope');
      ropeBox.textContent = '';
      ropeBox.appendChild(_ropeCard(rope));

      const { friends, pending } = await api('/social/friends');
      const pendingBox = $('wallPending');
      pendingBox.textContent = '';
      pending.forEach(p => pendingBox.appendChild(_pendingRow(p)));

      const list = $('wallFriends');
      list.textContent = '';
      if (!friends.length) list.appendChild(_el('p', 'wall-empty', t('wall.noFriends')));
      friends.forEach(f => list.appendChild(_friendRow(f)));

      const board = $('wallBoard');
      board.textContent = '';
      if (scope === 'global' && !profile.on_global_board) {
        board.appendChild(_globalInvite());
      } else {
        const data = await api(`/social/leaderboard?scope=${scope}`);
        board.appendChild(_boardRows(data.rows));
      }
      loaded = true;
    } catch (err) {
      _showError(err);
    }
  }

  function _gate() {
    const inside = Auth.isLoggedIn();
    $('wallGate').classList.toggle('hidden', inside);
    $('wallBody').classList.toggle('hidden', !inside);
  }

  function init() {
    // Етикетът е скрит за четец на екран; видимото упътване е в самото поле.
    const field = $('wallFriendCode');
    const label = () => { field.placeholder = t('wall.codeLabel'); };
    label();
    window.addEventListener('climby:lang-changed', label);

    $('wallAddBtn').addEventListener('click', _add);
    $('wallFriendCode').addEventListener('keydown', e => { if (e.key === 'Enter') _add(); });

    document.querySelectorAll('.wall-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        scope = tab.dataset.scope;
        document.querySelectorAll('.wall-tab').forEach(o => o.classList.toggle('active', o === tab));
        refresh();
      });
    });

    window.addEventListener('climby:auth-changed', () => { _gate(); loaded = false; });
    window.addEventListener('climby:view-shown', e => {
      if (e.detail.view !== 'wall') return;
      _gate();
      // Числата се менят, докато човекът е бил другаде — затова при всяко
      // влизане, а не само първия път.
      if (Auth.isLoggedIn()) refresh();
    });
    _gate();
  }

  return { init, refresh, isLoaded: () => loaded };
})();

document.addEventListener('DOMContentLoaded', Wall.init);
