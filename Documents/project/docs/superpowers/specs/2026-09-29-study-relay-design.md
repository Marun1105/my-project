# The study relay — design

Sub-project 1 of `docs/plan-2026-09-climby-2.md`. Decisions are Martin's unless
marked **proposed**.

## Problem

Every student-facing AI call runs on Haiku 4.5. It cannot reliably read a
photographed page of handwritten Bulgarian geometry, and cannot reliably solve
one. A student photographed problems 21–24 and was asked to type them out.

## Decisions

| | |
|---|---|
| Photographs | Opus 5 reads them **once** and writes a description Haiku can understand perfectly |
| Maths, physics, chemistry | the description also carries the **worked solution, explained step by step with why**, hidden from the student |
| Other subjects | description only |
| Typed hard problems in chat | Haiku consults Opus through the **advisor tool**, at most once per message — "don't overdo it" |
| Web search | Haiku may search for **methods and facts**; answer-key sites (решебници) are blocked |
| Asking for the answer | if the student asks for it, they get it — no counting. It never counts as *solved on your own* |

## How it works

```
first question on a photo
  photos ──▶ Opus 5 (reader) ──▶ problem_brief row ──▶ brief_id to client
                                     │
                                     ▼
                              Haiku 4.5 tutors, reading the brief
                              (no images sent to Haiku)

follow-up on the same photo
  brief_id ──▶ brief loaded ──▶ Haiku 4.5 tutors
               (no photos uploaded again)

typed chat
  question ──▶ Haiku 4.5 + advisor(Opus 5, max_uses 1) + web search
```

### The reader

One Opus 5 call per set of photographs. Output in two tagged parts:

- `<read>` — what is on the page: the problems by number, given, asked,
  what is legible and what is cut off. **Returned to the client** and shown as
  "What ClimbAI read", so a misreading can be seen and corrected.
- `<solution>` — present only for maths, physics, chemistry. Step-by-step, with
  the reason for each step and the likely mistake. **Never leaves the server.**

### The brief

`problem_brief(id uuid, user_id nullable, subject, read_text, solution_text
nullable, created_at)`. Keyed by an unguessable id so guests work too. A brief
owned by an account can only be used by that account.

### The tutor turn

Haiku receives the brief in its system prompt: the read part as the problem,
the solution under a rule — steer by it, never reveal it unless the student
asks for the answer.

### Degradation

If the reader fails (API error, timeout, refusal), the turn falls back to
today's behaviour: Haiku with the images. The student never sees the relay fail.

### Search fence

Basic `web_search_20250305` (the variant Haiku 4.5 supports), `max_uses: 2`,
`blocked_domains`: domashno.bg, zadachite.net, gdz.ru, reshak.ru, resheba.top,
skysmart.ru, reshebnik.ru. The prompt limits it to methods and facts.

### Answer on request

The tutoring rule changes from *"if they ask for the answer outright, give the
path and leave the last step to them"* to: hints first by default; if the
student explicitly asks for the answer, give it, explained. The solved-alone
marker already excludes answers the tutor gave.

## Frontend

- Follow-ups send `brief_id` instead of re-uploading every photograph.
- **Proposed.** A reading state while Opus works — it is slower than Haiku and
  the wait needs to look intentional.
- **Proposed.** "What ClimbAI read" — a collapsible panel under the first answer
  showing the `<read>` part.

## Measured, 2026-09-29, against the live models

On the real photograph of problems 21–24:

| path | time | cost | result |
|---|---|---|---|
| Reader, solving all 4 problems, medium effort | 77 s | ~$0.17 | too slow — the client times out at 120 s |
| Reader, scoped to the question, **low effort** | **33 s** | **~$0.06** | read all 4; solved 22 = **30 cm²**, correct, self-checked with coordinates |
| Reader, scoped, medium effort | 48 s | ~$0.09 | same answer |
| Haiku + advisor, uncapped | 82 s | — | good method, far too slow |
| Haiku + advisor, `max_tokens: 2000` | **26 s** | ~$0.05 | grade-7 method (parallel line through M) |
| Haiku alone, no advisor instruction | 5 s | — | suggested coordinate geometry to a 7th-grader — the original failure |

Consequences for the build:

- The reader receives the **student's question** and solves only that problem.
  It still reads the whole page, so follow-ups about another problem have the
  givens; the advisor covers solving those.
- Reader effort `low`. Advisor capped at 2000 tokens.
- Haiku only consults the advisor when told exactly when to — the instruction
  names the cases (proofs, geometry, word problems, choosing a method).
- Haiku sometimes narrates the consultation ("let me consult…") before the tool
  call. The server keeps only the text **after** the last tool result.
- The reader is told the page is Bulgarian; without that it called the
  handwriting Russian.

Follow-ups stay on Haiku. The daily token cap applies to all of it.

## Testing

Stubbed Anthropic client: reader called once per photo set and never on
follow-ups; solution never in any response body; brief ownership enforced;
fallback when the reader fails; advisor and search present only where decided;
blocklist present. Then one real call per path against the live models.
