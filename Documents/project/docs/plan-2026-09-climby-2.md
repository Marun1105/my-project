# Climby 2 — the plan

Written 2026-09-29, after the decision to make competition the spine of the app
rather than a feature hanging off it. Nothing here is built. This document
exists to be argued with first.

Three things change at once, and they depend on each other in this order:

1. **The tutor stops being bad at its job.** Nothing else matters if a student
   photographs a page and is told to type it out.
2. **The tutor starts knowing who it is talking to.** A tutor with memory is a
   different product from one that forgets you every morning.
3. **The app becomes a place other people are.** Competition, groups, presence.

The order is not negotiable. A social layer on top of a tutor that cannot read
a page of geometry is a nicer-looking disappointment.

---

## Part 0 — who this is for

**12 to 18.** That is the realistic user, and it settles several arguments:

- In Bulgaria a child can consent to an information-society service on their own
  at **14**. Below that a parent must. So 12–13 needs a parent in the loop and
  14+ does not — and Rope Team already exists as the mechanism.
- A 15-year-old will not use something that looks like it was made for a
  seven-year-old. The visual direction can grow up.
- The grades 1–4 register in the tutor prompt stays, because a younger sibling
  will use it, but it stops being the design centre.

**And a second audience, which may turn out to be the real one:** people who
struggle to concentrate, who want to be in a group with others who struggle the
same way. That is not a class. It is a self-formed group, and it changes the
safety design completely — see Part 4, which is the most important part of this
document.

---

## Part 1 — a tutor that can read

### What is wrong now

Every student-facing call runs on **Haiku 4.5** (`server.py:1017`,
`planner.py:120`, `planner.py:148`). It is the smallest model in the family. The
two things it is weakest at — reading faint handwriting, and multi-step
reasoning — are exactly the two things a photographed geometry page demands.

We already wrote a Bulgarian notation glossary and an app map to help it. Prompt
work cannot make Haiku see what Opus sees.

### The relay

Opus reads the page **once**. Haiku carries the conversation, which is the part
that repeats.

```
photo ──▶ Opus 5 ──▶ a brief ──▶ stored ──▶ Haiku 4.5 ──▶ the student
          (once)                             (every turn)
```

The brief is not a transcription. A transcription fixes reading and leaves Haiku
to construct a proof it cannot construct. The brief carries the solution too:

```
On the page:   problems 21–24, handwritten Bulgarian, pencil
Problem 22:    AP:PC = 2:1 · M is the midpoint of BC · S_AON = 8 cm²
Asked:         S_ABC
Route:         area ratios through the centroid
Answer:        24 cm²                        ← tutor's eyes only, never shown
Trap:          students divide where they should multiply
Legible:       21, 22, 23 clearly; 24 is cut off at the bottom
```

Haiku then runs a hint ladder **over a problem that is already solved**. That is
a job it is good at. It never has to derive anything; it has to decide how much
to give away, which is a conversation skill.

### What this costs

| | input | output | when it runs |
|---|---|---|---|
| Opus 5 | $5/MTok | $25/MTok | once per photograph |
| Haiku 4.5 | $1/MTok | $5/MTok | every turn |

A photographed page is roughly 1.6k image tokens plus prompt. Say 5k in, 1k out
on Opus ≈ **$0.05 per photo**. Fifty photos a day ≈ $2.50/day ≈ $75/month, and
every follow-up turn after the first is Haiku at a tenth of that.

Current real usage is under 20k tokens a day across everything. At today's
volume this is **pennies**. The existing daily spend cap already protects
against a runaway.

### Web search, and the fence it needs

Haiku 4.5 gets the basic `web_search_20250305` variant (the newer
dynamic-filtering one needs Opus 4.6+ / Sonnet 4.6+). To be verified with one
real call before we depend on it.

**The fence matters more than the feature.** A student photographs *задача 22,
стр. 32* from a standard textbook. Решебник sites exist for every Bulgarian
textbook in print. An unfenced search finds the answer key and the entire
hints-first design dies in one turn.

Rules:
- Search is for **facts**: a formula, a date, a definition, a word, a unit.
- Search is **never** for "the answer to this exercise", and the tutor is told
  so explicitly.
- Blocked domains for the known answer-key sites, as a second line.
- If the brief already contains the answer, there is nothing to search for.

### Escalation

Some problems are beyond Haiku even with a brief. Rule: if the student has had
three turns on the same problem without progress, the next answer is generated
by Opus. Rare, bounded, and it rescues exactly the cases that would otherwise
make a student give up.

---

## Part 2 — memory

### Two levels, named by what they do

**Remembers** — the default, and close to what exists today.
What is on your Route, what you asked before, the briefs of problems you
photographed, your grade and town. Continuity: *"the one like the triangle from
Tuesday"* means something.

**Learns you** — opt-in, and the serious one.
How you explain things back. Where you get stuck, by topic. Which wording lands.
How fast you move. What time of day you actually work. Whether you want the idea
first or the example first.

A profile that gets written after each session, in the tutor's own words, and
read back into the system prompt on every request:

```
Martin, 15, grade 9, Plovdiv.
Works between 19:00 and 22:00, in 25-40 minute sessions.
Strong: algebra, anything procedural. Fast once he sees the pattern.
Struggles: geometry proofs — starts from the picture, not from what is given.
Wants the idea before the example. Goes quiet rather than asking again
  when he does not follow; a direct "does that make sense?" gets an
  honest answer where an open question does not.
Solves unaided most often in the second half of a session.
```

That is the difference between a chatbot and a tutor who knows you.

### Consent

- **14 and over** — the student consents for themselves, on a screen that says
  in plain words what is kept and what it is for.
- **Under 14** — a parent consents through Rope Team. Not a checkbox the child
  ticks claiming to be a parent; a real prompt on the linked parent's side.
- **Revocable** — one switch in Settings. Turning it off **deletes** the
  profile, it does not hide it.
- **Visible** — the student can read their own profile, in full, in the same
  words the tutor sees. If a line in it is wrong or unkind, they can delete it.
  A profile a student is not allowed to read is a file being kept on a child.

That last rule is worth more than any policy text. It keeps the feature honest:
if we would be embarrassed for the student to read a line, it should not be
written.

---

## Part 3 — the arena

### Base Camp becomes the place the app lives

```
┌─ BASE CAMP · 7б ───────────────────────────┐
│  THIS WEEK                ▾ solved alone   │
│                                            │
│   1  Ivan       ▲ +12    🟢 studying now   │
│   2  YOU        ▲ +9                       │
│   3  Maria      ▲ +7     🔥 6 days         │
│   4  Georgi     ▲ +3                       │
│                                            │
│  ────────────────────────────────────────  │
│   Ivan started a focus session, 20m in     │
│   Maria summited "Geometry — ex 4–6"       │
│   Georgi solved 2 on his own today         │
└────────────────────────────────────────────┘
```

### What is ranked

**Solved on your own** — the signal built on 2026-09-24. It is the only number
in the app that goes up when a student needs *less* help. Everything else
(questions asked, minutes sat) rewards leaning on the tutor harder, and would
teach students to farm the leaderboard by asking more.

Default sort is **improvement on your own last week**, not raw totals. Raw
totals rank the strongest student first every week forever, and tell the student
who most needs the app that they are last at the thing they came here to fix.
On improvement, everybody can be first, and the student climbing from 2 to 6
beats the one who went from 14 to 14.

Raw totals stay available as a second tab for those who want it.

### Presence, not chat

*"Ivan is in a focus session, 20 minutes in."*

This is the Bump-like pull — knowing somebody else is there right now — and it
is worth more here than music would be. Seeing a classmate working at 20:00 is a
stronger nudge to open your books than seeing their playlist, and it costs no
third-party integration.

**Spotify: not now.** It is OAuth, a third party, a privacy surface, and it
serves the vibe rather than the studying. Revisit when the core loop is working
and there are users to delight.

### Groups that are not classes

A class needs a teacher and a code. The second audience — people who cannot
concentrate, who want others like them — has no teacher. So:

- **Class groups** — created by a teacher, joined by code. As today.
- **Open groups** — created by anyone, joined by code or invite. "Матура 2027",
  "Не мога да се концентрирам", a group of four friends.

Same leaderboard, same presence, same rules. The difference is who vouches for
the members, and that difference is the whole of Part 4.

---

## Part 4 — safety, which is the hard part

This is the section to argue with hardest, because it is where a good idea
becomes a bad one quietly.

The moment the app lets a 12-year-old join a group of strangers who have
self-identified as vulnerable ("I can't concentrate"), it has built the exact
conditions that people who target children look for: minors, a shared
vulnerability, and a private channel.

### The position I would argue for

**No free text between students. Anywhere. Ever.**

Not in groups, not in profiles, not in direct messages — because there are no
direct messages. What passes between students is:

- numbers (solved, streak, minutes)
- presence (studying now / not)
- fixed, app-generated events ("summited Geometry — ex 4–6")
- a reaction from a closed set (👏 🔥 💪) with no text

You keep **all** of the motivation. Watching a classmate's number move is the
thing that pulls. A chat box adds very little to that and adds every risk.

If chat is wanted later, it belongs inside a class with a named teacher who can
see it — never in an open group.

### Verification, in layers

| What | Why |
|---|---|
| Verified email, as today | a floor, not a wall |
| A group has a named owner | somebody is accountable for it |
| Open groups are invite/code only, never browsable | you cannot go shopping for children |
| Display name + avatar initial only — no photos | the profile picture is the recruiting poster |
| No free text anywhere, including display names beyond a first name | names are a channel too |
| Report + leave on every group, one tap | the student can always get out |
| A parent on Rope Team sees which groups their child is in | for under-14s, this is the consent anyway |
| Rate limit on group creation and joins | slows down anyone farming |

### What I would not build

- Public browsable groups or a directory
- Profile photos
- Any student-to-student free text
- Location, school name as a searchable field, or anything that helps one
  student find another in the physical world

### The honest trade

This makes Climby a weaker social network and a better place to leave a
14-year-old. I think that is the right trade for this product, and I think the
motivation survives it almost entirely — because the motivating thing was never
the chat, it was seeing that Ivan is 3 ahead of you and studying right now.

---

## Part 5 — the look

You want Bump's feel. I have not used it, so this section is deliberately thin
until you put a few screenshots in `docs/design/`.

What I would ask for when you do: **which two or three screens** you want to
feel like, and whether it is the typography, the colour, the density, the
motion, or the photography that grabs you. Those are four different jobs.

What I would say now, from the screenshots of Climby: it is clean and it is
*empty*. The nav uses a third of the sidebar, the screens use the top half. For
a 15-year-old the app should feel full of activity the moment it opens, and the
arena is what fills it.

---

## Part 6 — data

New tables:

```
group                id, kind(class|open), name, owner_id, join_code,
                     created_at, member_cap
group_member         group_id, user_id, role(owner|member), joined_at
presence             user_id, kind(focus|tutor), started_at, expires_at
student_profile      user_id, level(remembers|learns), body, updated_at,
                     consented_by(self|parent), consented_at
problem_brief        id, user_id, scan_id, body, model, created_at
reaction             from_user, to_user, event_id, kind, created_at
```

`classroom` and `classroom_member` already exist and are the class case of
`group`. They should be migrated into it rather than run alongside — two
half-overlapping concepts is how this becomes unmaintainable.

`presence` is deliberately short-lived, with an `expires_at`, so "studying now"
cannot be stale and there is no long-term log of when a child was at their desk.

---

## Part 7 — order of work

Each step ships on its own and is worth having even if the next never happens.

1. **The relay.** Opus reads, brief stored, Haiku teaches. Escalation after
   three stuck turns. → The tutor stops failing at the thing it is for.
2. **Search, fenced.** Facts only, answer-key domains blocked.
3. **Memory: Remembers.** Continuity across sessions, no profiling, no new
   consent needed beyond what exists.
4. **Memory: Learns you.** Consent screen, parent path under 14, readable and
   deletable profile.
5. **Groups.** `group` table, classes migrated in, open groups, codes, caps.
6. **The board.** Weekly, improvement-sorted, solved-alone. Raw totals second.
7. **Presence.** Studying-now, with the short expiry.
8. **Reactions.** The closed set. Last, because it is the smallest win.

Steps 1–4 are the tutor. 5–8 are the arena. If the tutor work runs long, the
arena waits, because an arena around a tutor that cannot read is a worse product
than a tutor that can read and has no arena.

---

## Open questions

1. **Screenshots of Bump** — which screens, and what about them.
2. **Who creates open groups?** Anyone, or only verified 16+, or only accounts
   older than N days? This is the main lever on how safe open groups are.
3. **Does a teacher see the class board?** And do they see names against
   numbers, or only the shape of the class?
4. **What happens when a student is bottom every week?** I would suggest the
   board simply does not show a position below a certain point — you see the top
   few and yourself, never "you are 24th of 24".
5. **Group size cap.** A group of 200 strangers is a different thing from a
   group of 8. I would cap open groups low — 20? — and let class groups be
   whatever the class is.
