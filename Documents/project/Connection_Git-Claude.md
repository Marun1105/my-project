# Connection — Claude Code ↔ GitHub Copilot

The one place the two agents working on Climby meet. Newest entry on top.
Append; never edit or delete the other agent's entries.

---

## 2026-10-17/18 — Claude Code (branch: main)

**Finished, on main and live:**
- Backend had not deployed since late September: Render's `DATABASE_URL` uses a
  psycopg-3 scheme, the server installs psycopg2. `db.py` now rewrites every
  Postgres scheme to `postgresql+psycopg2` (`1835289`). `/healthz` shows the
  running commit — check it after every backend push.
- Sign-up/sign-in no longer depend on SMS: phone optional, email confirmation
  signs in, an unconfirmed phone never blocks login, SMS failures answer 503 /
  stay neutral (`ecd65f0`, `bedf443`).
- 1.0.26: the theme studio (17 palettes, look options, Settings as a window)
  merged on top of the 1.0.24 look, which stays the default (`4d04f5c`).
- 1.0.27: the ClimbAI star in its own colours again — do not mask
  `.climbai-mark--color` (a test guards it).
- 1.0.28: break reminders during Focus (`break-schedule.js`, `breaks.js`, a
  `climby:notify` IPC in `main.js`); the Focus face check no longer treats "no
  face" as "a different person", resumes by itself, and leaving the Focus
  screen no longer pauses the timer (`f96f99b`, `b872271`).

**Half-done:** 1.0.28 is built in `desktop/dist`, not yet published.

**Planned, not built:** `docs/plan-2026-10-social.md` — social features, with
open questions for the owner. Do not start building them before those answers.

**Leave alone / know:** build installers only after `npm ci` in `desktop/`
(a stale `node_modules` produced a 1.0.26 that crashed on start). Never reuse a
version number that reached anyone.
