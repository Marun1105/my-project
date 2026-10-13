# Clibis, friends and the Wall — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a student a reason to come back on a day with no urgent homework — a currency they earn by working, a small circle of people they chose, and a board that says where they stand.

**Architecture:** Five new tables, no migration (SQLAlchemy's `create_all()` makes missing tables at startup; only new *columns* on existing tables need `migrations.py`, and this plan adds none). Two new routers, `clibis.py` and `social.py`, mounted like `classes.py`. `clibis.award()` is the only writer of currency and is called from the three places where real work is recorded — never from an HTTP handler, so no request can mint clibis directly.

**Tech Stack:** FastAPI, SQLAlchemy 2.x, Pydantic v2, vanilla JS frontend, pytest.

**Spec:** `docs/superpowers/specs/2026-10-13-climby-social-motivation-design.md`

## Global Constraints

- **Only numbers are ever seen by a peer.** No task text, no question, no answer, no email, in any response a peer can reach. From `classes.py`'s header rule.
- **No migration.** New tables only. `migrations.py` must not be edited by this plan.
- **Names are taken.** `nav.family` is already **Rope Team** and `nav.classes` is **Base Camp**. The new names are:
  - **The Wall** / «Стената» — the new screen (friends, balance, leaderboard)
  - **Rope partner** / «Свръзка» — two friends, one weekly goal (`свръзка` is the Bulgarian climbing word for a roped pair)
  - **Anchor** / «Клин» — a day of streak bought with clibis
  - **clibis** / «клиби» — the currency
- **Both languages.** Every user-facing string goes through `i18n.js`, `bg` and `en`.
- **Awards are idempotent** on `(user_id, reason, ref_id)` — enforced by a unique constraint, not by checking first.
- Daily cap: **120 clibis**. Rates: `solved_step` 15, `task_done` 10, `focus_session` 5, `streak_day` 5, `rope_bonus` 25.
- Anchor costs **60 clibis**, maximum **one per calendar month**.

## Review Focus

Five things the spec implies but no happy-path test would catch:

1. **A task toggled done → undone → done pays twice** unless `ref_id` is the task id and the constraint holds. Test in Task 2.
2. **The daily cap is read-then-write** — two concurrent requests both see 110 and both award. Test in Task 1 (the cap is applied inside the same transaction as the insert).
3. **A removed friend keeps reading the profile** if access is checked against a cached list. Test in Task 5.
4. **`display_name` leaks onto the global board** through a shared Pydantic model. Test asserts on the serialised JSON, not the model, in Task 5.
5. **An anchor bought for a day already covered** takes the clibis and does nothing. Test in Task 7.

---

### Task 1: The ledger and `award()`

**Files:**
- Modify: `models.py` (add `ClibiLedger`)
- Create: `clibis.py`
- Test: `test_clibis.py`

**Interfaces:**
- Produces: `clibis.award(db, user_id: str, reason: str, ref_id: str) -> int` (returns clibis actually granted, 0 if already paid or capped); `clibis.balance(db, user_id: str) -> int`; `clibis.RATES: dict[str, int]`; `clibis.DAILY_CAP: int`

- [ ] **Step 1: Write the failing tests** — same `(reason, ref_id)` pays once; an unknown reason raises; the cap stops the 13th task of a day but not the 12th; `balance` sums only that user's rows.
- [ ] **Step 2: Run them, see them fail**
- [ ] **Step 3: Add `ClibiLedger` to `models.py`** — `id`, `user_id` FK indexed, `amount` Integer, `reason` String, `ref_id` String, `created_at`, `UniqueConstraint("user_id", "reason", "ref_id")`.
- [ ] **Step 4: Write `clibis.py`** — `award()` inserts and catches `IntegrityError` → rollback → return 0. The cap is a `SUM` over today's rows taken in the same transaction as the insert.
- [ ] **Step 5: Run the tests, see them pass**
- [ ] **Step 6: Commit**

### Task 2: Paying for work actually done

**Files:**
- Modify: `tasks.py` (`update_task`), `focus_sessions.py` (`create_session`), `server.py` (where `ScanHistory` is written, ~line 1174)
- Test: `test_clibis_awards.py`

**Interfaces:**
- Consumes: `clibis.award`
- Produces: nothing new; `_award_day()` is private to `clibis.py`

- [ ] **Step 1: Write the failing tests** — completing a task pays 10; un-completing and re-completing the same task pays nothing more; a focus session under `MIN_SESSION_SECONDS` pays nothing; an answer with `solved_unaided` pays 15 and one without pays nothing; the first award of a day also pays `streak_day` once.
- [ ] **Step 2–5: red, implement, green.** Each call site is wrapped so a failure to award never fails the request it rides on — the pattern `server.py` already uses for `ScanHistory` (try/except, rollback, print).
- [ ] **Step 6: Commit**

### Task 3: `GET /clibis/me`

**Files:** Modify `clibis.py` (add the router), `server.py` (mount it). Test: `test_clibis.py`

- [ ] Balance plus the last 20 ledger lines, each with reason and amount, so "why do I have 240?" has an answer. Reasons are enum strings the client translates — never server-side prose.
- [ ] Commit.

### Task 4: Friends by code

**Files:** Modify `models.py` (`SocialProfile`, `Friendship`), create `social.py`, modify `server.py`. Test: `test_social_friends.py`

**Interfaces:**
- Produces: `social.are_connected(db, a_id, b_id) -> bool` (friends, or in one classroom together) — Task 5 and Task 6 both use it.

- [ ] `SocialProfile`: `user_id` unique, `friend_code` unique (the `classes.py` alphabet, no `0/O/1/I`), `nickname` nullable, `on_global_board` Boolean default False. Made on first read, so old accounts get one without a migration.
- [ ] `Friendship`: `requester_id`, `addressee_id`, `status`, `UniqueConstraint(requester_id, addressee_id)`.
- [ ] Endpoints: `GET /social/me`, `POST /social/friends/code/{code}`, `POST /social/friends/{id}/accept`, `GET /social/friends`, `DELETE /social/friends/{id}`.
- [ ] Tests: your own code is refused; an unknown code 404s; a second request between the same pair does not make a second row; either side can delete.
- [ ] Commit.

### Task 5: Profile and the Wall

**Files:** Modify `social.py`. Test: `test_social_board.py`

- [ ] `GET /social/profile/{user_id}` → 403 unless `are_connected`. Returns clibis, streak days, solved count, focus minutes, grade. **Nothing else.**
- [ ] `GET /social/leaderboard?scope=friends|class|global&period=week|all`.
- [ ] Tests, including the two from Review Focus: deleting a friendship immediately 403s the profile, and a `global` response's **JSON text** contains no `display_name` key and none of the fixture's real names.
- [ ] Commit.

### Task 6: Rope partner (Свръзка)

**Files:** Modify `models.py` (`RopePartner`), `social.py`. Test: `test_rope_partner.py`

- [ ] `RopePartner`: the two user ids, `week_start` (Monday, `Europe/Sofia`), `target` clibis each, `settled` Boolean.
- [ ] Only between accepted friends. One active partner per student per week.
- [ ] At read time, if the week is over and both met the target, `award(reason="rope_bonus", ref_id=partner_id)` for each and mark settled. Settling on read, not on a clock — Render sleeps free services, the same reason `_sweep_guest_briefs` sweeps on the way past.
- [ ] Tests: both hit → both paid once even when read twice; one misses → neither paid; a bonus for a week already settled is not paid again.
- [ ] Commit.

### Task 7: Anchor (Клин)

**Files:** Modify `models.py` (`StreakAnchor`), `clibis.py`, `activity.py`. Test: `test_anchor.py`

- [ ] `StreakAnchor`: `user_id`, `day` (Date), `UniqueConstraint(user_id, day)`.
- [ ] `POST /clibis/anchor` with a day: refuses if the balance is under 60, if that day already has an anchor, or if one was bought this calendar month. Spends by inserting a **negative** ledger row (`reason="anchor"`, `ref_id=the day`), so the ledger still sums to the balance.
- [ ] `GET /activity` gains `anchored: [date]`. The browser's existing streak calculation treats an anchored day as active.
- [ ] Tests: the Review Focus case — buying an anchor for an already-anchored day returns 409 and the balance does not move.
- [ ] Commit.

### Task 8: The Wall screen

**Files:** Modify `frontend/index.html`, `frontend/style.css`, `frontend/i18n.js`, create `frontend/wall.js`. Test: `test_frontend_checks.py`

- [ ] Nav entry + `view-wall`, following the existing `data-view` / `Nav.activate` pattern.
- [ ] Your clibis and streak at the top; friends under it with their numbers; the board with three scope tabs, `friends` selected.
- [ ] The global tab, when `on_global_board` is false, shows what joining means before it shows a board — a nickname is required and the real name is never sent.
- [ ] Both languages in `i18n.js`.
- [ ] Commit.

### Task 9: Rope partner and Anchor on screen

**Files:** Modify `frontend/wall.js`, `frontend/i18n.js`, `frontend/style.css`, `frontend/checklist.js` (the streak line). Test: `test_frontend_checks.py`

- [ ] Proposing a rope partner from the friends list; the pair's progress toward the shared target.
- [ ] The anchor offered only where the streak is shown, only when the balance allows it, and worded as what it does: the day counts even though nothing was done.
- [ ] Commit.
