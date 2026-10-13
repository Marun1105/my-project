# Connection_Git-Claude

Where the two agents working on Climby meet. Claude Code (in the terminal) and
the GitHub agent cannot see each other's conversations, so whatever one of them
needs the other to know goes here.

**How to use it:** append an entry at the top, never edit or delete someone
else's. One entry per session. Say which branch you were on, which files you
touched, what is finished, what is half-done, and anything the other agent
should leave alone. Commit it together with the work it describes.

---

## 2026-10-13 · Claude Code · branch `worktree-social-clibis`

### Finished

- **The start-question card is bigger.** `frontend/style.css` —
  `.onboarding-card` went from `max-width: 380px` to `560px`, with `clamp()`
  padding and type so a phone still fits it, and `.onboarding-body` capped at
  `46ch` so the wider card does not stretch the sentence. Asked for: "like the
  GitHub and Claude settings menu size".
- **A design spec for the social feature**, at
  `docs/superpowers/specs/2026-10-13-climby-social-motivation-design.md`.
  Clibis (an append-only ledger), friends by code, and a leaderboard with
  `friends` / `class` / `global` scopes. **Not implemented — awaiting review.**

### Known from earlier sessions, still open

- **The Render deploy has been stale since 24 September.** The live `/phone`
  md5 is `77637eb32efd60349585d8d65d087057`; HEAD's is different. `/healthz`
  returns ok because Render keeps the *previous* build serving when a new one
  fails to boot, so green proves nothing. Deploys fail with "Exited with status
  1 while running your code". Leading suspicion: `DATABASE_URL` changed after
  24 September and the running process still holds the September value —
  migrations run unguarded at import in `server.py:62-65`, so a bad URL kills
  the process. **Needs a human to read the Render deploy log.** Nothing
  backend ships until this is understood.
- `v1.0.15` installer is unpublished and now ~12 commits stale.
- README drift: commands in the root README do not work from the repo root,
  and it claims pushing to `main` deploys, which ignores the paths filter in
  `.github/workflows/deploy-backend.yml`.

### For the GitHub agent specifically

- `frontend/style.css`, `frontend/index.html` and the logo PNGs had
  uncommitted changes in the main checkout on 2026-10-13 (a logo pass). I did
  **not** touch them — my style.css edit is on `worktree-social-clibis` and is
  confined to the five `.onboarding-*` rules. Expect to merge, not to be
  conflicted, unless you also changed those rules.
- A history rewrite is pending: every `Co-Authored-By: Claude` and
  `Claude-Session:` trailer is to be stripped from all 181 commits that carry
  one, across all branches and tags. Verified on a throwaway clone — trees come
  out byte-identical, messages intact. It has not been run on the real repo.
  **When it is, every commit SHA changes and any other clone must re-clone.**
  Do not push long-lived work you cannot recreate until that has happened.
