# Climby: clibis, friends and the leaderboard

Status: **awaiting review** · 2026-10-13 · branch `worktree-social-clibis`

## What this is for

A student finishes their homework and nothing happens. The checklist empties
and the screen goes quiet. `activity.py` already counts a streak and a solved
total, but only the student sees them, and a number only you can see stops
being a reason to come back after about a week.

This adds the part that makes it worth coming back: a currency called
**clibis**, a small circle of people you chose, and a board that says where you
stand. Not a feed, not chat, not homework sharing — those were considered and
rejected (see Rejected below).

Success looks like: a student opens Climby on a day they have no urgent
homework, because they want to see where they are.

## The rule everything obeys

`classes.py` already states it, and this design does not get to weaken it:

> what is *seen* is the same — only numbers, never the text of a task or a
> question to the AI tutor

So a profile another student can open shows counts and nothing else. No task
text, no question, no answer, no email, no photographed page. A peer can see
*that* you solved eleven things. Never *what*.

## Clibis

An append-only ledger, not a number on the user row:

```
clibi_ledger
  id          str  pk
  user_id     str  fk users.id, indexed
  amount      int  always positive in v1
  reason      str  'task_done' | 'solved_step' | 'focus_session' | 'streak_day'
  ref_id      str  the task/session/day this paid for
  created_at  datetime
  unique (user_id, reason, ref_id)
```

The balance is `SUM(amount)`. A stored total would drift the first time a
request is retried; a ledger cannot, and it answers "why do I have 240?" —
which a child *will* ask, and which a stored integer cannot.

The unique constraint is the anti-abuse mechanism. Awarding is idempotent on
`(user_id, reason, ref_id)`, so a double-tapped button, a flaky phone
connection or a Render cold-start retry pays once.

### What earns clibis

| Reason | Clibis | Why this and not more |
|---|---|---|
| `task_done` | 10 | the thing the app is for |
| `solved_step` | 15 | `activity.py` already records reaching a step without being told the answer |
| `focus_session` | 5 | per completed session, `focus_sessions.py` |
| `streak_day` | 5 | one per calendar day with any activity |

`solved_step` pays more than `task_done` on purpose. Asking ClimbAI for the
answer must never be the fastest way to get rich, or the currency teaches the
opposite of what the app is for. Nothing pays for *asking* a question.

Daily cap: 120. A student who finds a way to loop a task cannot run away with
the board, and the cap is high enough that an honest heavy day never hits it.

Guests earn nothing — they have no `user_id`, and the ledger's FK says so.

### What clibis are for

v1: they are a score. Nothing to spend them on yet. Adding a shop in the same
change would double the work and the first thing to get wrong. "Streak freeze"
(below) is the first spend worth building, once the earning side is real.

## Friends

```
friendships
  id            str  pk
  requester_id  str  fk users.id
  addressee_id  str  fk users.id
  status        str  'pending' | 'accepted'
  created_at    datetime
  unique (requester_id, addressee_id)
```

Added by **friend code**, the same mechanism `classes.py` and `family.py`
already use — a short code from an alphabet with no `0/O/1/I`, because it gets
read out loud across a classroom. No search by name, no "people you may know",
no email lookup: a child cannot be found in Climby by someone who does not
already know them in person.

A request needs accepting. Either side can remove the friendship, and removing
it is immediate and total.

## The leaderboard

Three scopes, one endpoint: `friends`, `class`, `global`. Two periods: `week`
(resets Monday) and `all`.

**`friends` is the default view**, and this is the main design decision in the
whole document. A global board of children, sorted by a number, means most of
them see themselves near the bottom — which demotivates exactly the student
the app is for. Among six friends everyone is somewhere reasonable.

**Global requires a nickname and is opt-in.** A student does not appear on a
global board under the name their teacher knows them by. To appear at all they
pick a nickname; `display_name` is never sent to a global board. Default is
off. Nicknames are checked against a blocklist and are not editable more than
once a week, so one cannot be used as a message.

The `class` scope reuses `classes.py` membership. A teacher's class is already
a group of people who know each other, so `display_name` is fine there.

## Shape of the code

New `social.py` (the graph and the boards) and `clibis.py` (the ledger). Both
routers, mounted like `classes.py`. `clibis.award()` is the only writer, called
from `tasks.py`, `activity.py` and `focus_sessions.py` — never from the HTTP
layer, so no request can mint currency directly.

```
GET    /social/me                     my card + balance
GET    /social/profile/{user_id}      a peer's card — 403 unless friend or classmate
GET    /social/friends                accepted + pending
POST   /social/friends/code/{code}    send a request
POST   /social/friends/{id}/accept
DELETE /social/friends/{id}
GET    /social/leaderboard?scope=&period=
GET    /clibis/me                     balance + the last 20 ledger lines
```

Frontend: one new view, `view-climbers`, following the existing `Nav.activate`
pattern — your card at the top, friends under it, leaderboard tabs at the
bottom. Bulgarian and English both, through `i18n.js` as everything else.

## Testing

Postgres, not SQLite — the project has been bitten by that before. The tests
that matter are the ones about money and privacy, not the happy path:

- awarding the same `(user_id, reason, ref_id)` twice pays once
- the daily cap holds across concurrent requests
- a non-friend, non-classmate gets 403 from `/social/profile`
- a global leaderboard response contains **no** `display_name` field at all —
  asserted on the serialised JSON, not on the model
- removing a friendship immediately revokes profile access
- nothing in any response body carries task text, a question or an answer

## Rejected

- **Messaging / "ask a classmate"** — moderation and safeguarding obligations
  for minors, and it turns a homework app into a chat app. Ruled out by Martin.
- **Sharing homework lists** — reveals what you are working on, i.e. content.
  Ruled out by Martin.
- **Phone-bump pairing** (accelerometer matching, the original Bump trick) —
  researched, then dropped: friend codes already solve pairing, and the bump
  needed either Web NFC (Android only, never iOS) or motion permission that
  iOS re-asks for every session.

## Open

- Does a class leaderboard need the teacher's consent to exist?
- Weekly reset: Monday 00:00 in `Europe/Sofia`, or UTC?
