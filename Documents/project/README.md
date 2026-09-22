# Climby

**Climb your way to success.**

Climby helps students in grades 1–12 understand their homework instead of
copying it. Photograph a problem from the textbook and ClimbAI works through it
with you — step by step, until it makes sense.

The app is in English and Bulgarian. It installs as a Windows application.

---

## What's inside

| Screen | What it's for |
|---|---|
| **ClimbAI** | Photograph a page and ask. The answer explains the path, not just the result. Reads aloud on request. |
| **Ascent** | A quiet timer while you study. Presence detection runs entirely on your device — no image ever leaves it. |
| **The Route** | Today's homework, most urgent first. A big task can be split into steps. |
| **Summited** | Everything you've finished, and every question you've asked. |
| **Rope Team** | A parent sees the numbers — how many tasks, how much time. Never what's in them. |
| **Base Camp** | A teacher creates a class with a code and sees the same numbers for the whole class, and nothing more. |

### ClimbAI, three ways in

- **The camera** on your laptop, for a page in front of you.
- **Your phone.** Show a QR code to your phone **once**, confirm that both screens show the same five-character code, and from then on every photo taken on the phone appears on the computer by itself, within a second or two.
- **Past exam papers.** Every national exam paper is a page the scanner already knows how to read. Pick the year and the page; name the problem; ask.

The phone receives a key that opens exactly two things: "upload a photo" and "am I still linked". It cannot sign in, read tasks or change a password. A lost phone can send you a photo and nothing else — and it can be unlinked from Settings in a click.

### The chat

The circle in the corner opens ClimbAI as a conversation over whatever screen you're on. No photo needed — this is for *"what is a prime number"*, not *"check problem 7"*. Same tutor, same rules.

### How the tutor teaches

By default ClimbAI gives hints and asks you to take the next step yourself; it moves to the full solution only when you ask. You can switch this in Settings, along with text size, a wider "easy reading" layout, reduced motion, and reading answers aloud automatically. These live on your device, not your account.

---

## Installing

1. Download `Climby-Setup-X.Y.Z.exe` from [Releases](https://github.com/Marun1105/my-project/releases).
2. Run it.

Windows may show a blue **"Windows protected your PC"** screen — the app isn't paid up for a code-signing certificate; it isn't a virus. Click **More info → Run anyway**.

From then on Climby updates itself: it checks on launch, downloads quietly, and asks when to restart.

You can sign in with an email and password, or with a Google account.

---

## Privacy

This is an app for children, so the lines are drawn deliberately and in one place:

- **Photos sent to the AI are not kept.** They are processed once and forgotten. History keeps only the text of the question and the answer.
- **One exception, for seconds:** a photo from a linked phone sits in the database until the computer collects it — usually a second or two, ten minutes at most. Collecting it deletes it.
- **The presence camera uploads nothing.** "Is there a face in front of the screen" is decided entirely in the browser. No frame leaves the device.
- **Parents and teachers see numbers, not content.** How many tasks, how many minutes, how many days in a row. Never what a problem said or what was asked.

The last one isn't a technical limitation; it's a decision. A student who knows every question is being read stops asking honestly — and asking is the whole point.

---

## For developers

### Inside

- **Backend:** FastAPI + SQLAlchemy. Postgres in production, SQLite locally.
- **Frontend:** plain HTML/CSS/JS, no framework, no build step.
- **Desktop:** Electron + electron-builder, updates through GitHub Releases.
- **AI:** Anthropic Claude.

### Running locally

```bash
pip install -r requirements.txt
python -m uvicorn server:app --reload          # backend, on :8000
cd frontend && python -m http.server 8001      # frontend, on :8001
```

Then open `http://localhost:8001`. The backend address picks itself: opened from localhost, the app talks to localhost. Nothing to configure by hand.

Environment variables: `ANTHROPIC_API_KEY` and `JWT_SECRET` are required. Optional: `DATABASE_URL` (otherwise SQLite), `RESEND_API_KEY` and `RESEND_FROM` (email), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Google sign-in), `TWILIO_*` (SMS), `PAPERS_CACHE_DIR`, `AI_DAILY_TOKEN_CAP` (the whole app's daily AI budget in tokens; default 3,000,000, 0 for none).

### Tests

```bash
python -m pytest -q
```

Alongside the usual ones there are static checks of the frontend: every translation exists in both languages, every id JavaScript looks for exists in the HTML, the service worker caches every local script, and the backend address points at production.

### Shipping

**Pushing to `main` deploys the backend.** Render auto-deploys on commit, and a free-tier build can take 20–30 minutes with no outward sign of progress; the old version keeps serving until the new one is ready. Unfinished work belongs on a branch.

The desktop app is a separate step — see [`desktop/RELEASE.md`](desktop/RELEASE.md). In short: bump the version in `desktop/package.json`, build, confirm `latest.yml` describes exactly that file, and press **Publish release** — not "Save draft". A draft is invisible to installed copies and the update fails silently.

Frontend changes reach people only through a new desktop build. `phone_page.html` is the exception: it ships with the backend.

### Notes

- [`docs/review-2026-09.md`](docs/review-2026-09.md) — a full product review: defects,
  copy, design, what behavioural design is worth doing for children and what isn't,
  and where the growth actually is.
- [`docs/ai-v-ucheneto.md`](docs/ai-v-ucheneto.md) — what the research says about AI's benefit and harm in learning, and what that meant for the decisions here.
- [`docs/proba-s-istinski-telefon.md`](docs/proba-s-istinski-telefon.md) — twenty minutes with a real textbook; the only thing that can confirm the scanner.
- [`docs/baza-danni.md`](docs/baza-danni.md) — why the database is on Neon, what broke with Render's free one, and the steps for moving.
- [`climby-plan.md`](climby-plan.md) — the specification and build order.
