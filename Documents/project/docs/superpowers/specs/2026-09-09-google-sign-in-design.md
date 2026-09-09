# Sign in with Google

**Status:** design agreed 2026-09-09, not yet implemented.

## Why

Children forget passwords. Recovering one depends on an email arriving, and email in Climby is the least reliable thing in the product. A second way in that needs neither a remembered password nor a delivered message removes both failures at once.

This is aimed at the **returning** user, not the newcomer. The person it helps most already has an account and cannot get into it.

## Scope

**In:** Google, on the desktop app and in the browser. Account linking. A role question for brand-new accounts. A *Set a password* option for accounts that have none.

**Out, deliberately:**

- **Microsoft** — same machine, different URLs. Build it after Google works; roughly a fifth of the effort once the first provider is proven.
- **Refresh tokens and any Google API access.** We ask for `openid email profile`, use the identity once at sign-in, and never speak to Google again.
- **PKCE.** It substitutes for a client secret. The code exchange happens server-side, where we have one.
- **The portable build.** It cannot register a URL scheme reliably, exactly as it cannot self-update today. Google sign-in is absent there; the password path remains.

## Flow

```
Climby app --1--> system browser --2--> Google
                                          |
   +--------------------------------------+
   v 3
/auth/google/callback  (backend)
   |  verify ID token -> apply linking rules -> mint Climby JWT
   v 4
climby://auth?t=<jwt>[&new=1]  --> Electron catches it -> signed in
```

1. **Start.** The app opens `/auth/google/start` in the system browser through the existing gated `shell.openExternal` (`desktop/main.js:81`). The backend generates a random `state`, stores it in an httpOnly cookie, and redirects to Google. Both ends of the browser journey are ours, so a cookie suffices and no table is needed.

2. **Google.** The real browser, where the address bar and padlock are visible. It cannot be an embedded webview: Google rejects those (`disallowed_useragent`) precisely so that apps cannot read their users' passwords.

3. **Callback.** Verify `state` against the cookie, exchange the code, verify the ID token signature against Google's JWKS. `PyJWT` is already a dependency and ships `PyJWKClient`, but **as installed it cannot verify RS256**: Google signs ID tokens with RS256, and PyJWT delegates that to `cryptography`, which is not installed — it raises `NotImplementedError`. So `requirements.txt` gains `pyjwt[crypto]`. `httpx` is also used for the token exchange; it is present today only as a transitive dependency and gets declared explicitly. Then apply the linking rules below and mint an ordinary Climby JWT via `security.create_access_token` — the same token the password path issues, so everything downstream is untouched.

4. **Return.** Redirect to `climby://auth?t=...`, with `&new=1` appended only when the account was created just now. `app.on('second-instance')` (`desktop/main.js:158`) already exists and needs only to read the URL out of `argv`. The app passes the token to `Auth._setSession(...)` and then calls `/auth/me` for the user record, so the URL carries a token and one flag and nothing else.

The client secret never leaves Render's environment.

## Data model

A new table, created automatically by `metadata.create_all` (`migrations.create_schema`), so it costs no migration step:

```
oauth_identities
  id
  user_id     -> users.id
  provider    'google'
  subject     the provider's stable id for this person
  created_at
  UNIQUE (provider, subject)
```

**The key is the provider's `sub`, not the email address.** Emails change — someone renames a Gmail, a school reissues an address — and matching on email would quietly create a second account and strand the first. `sub` does not change. The same shape accepts Microsoft later with no schema change, and lets one person hold both.

### The one awkward migration

`users.password_hash` must become nullable, because a Google-only account has no password.

`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL` is **Postgres-only**; SQLite cannot relax a column constraint without rebuilding the table. `migrations.py` has `_add_column` and `_add_nullable_column` but nothing for this, so a new Postgres-guarded step is required.

Fresh SQLite databases take the constraint from the model definition, so tests are unaffected. A pre-existing local `climby.db` keeps the old constraint, which is harmless because nobody signs in with Google locally. This asymmetry belongs in a comment, not hidden.

## Linking rules

In order:

1. **Known `(provider, subject)`** — sign in. The ordinary case; it never consults the email address at all.

2. **Unknown identity and `email_verified` is false** — **refuse**, and say to use the password instead.

   This is the entire takeover guard. Without it, anyone able to create a provider account asserting an address owns the Climby account behind it. Google effectively always sends `true`; Microsoft personal accounts do not.

3. **Unknown identity, email verified, an account exists with that address** — attach the identity and sign in. This is the case that rescues the child who forgot their password.

4. **No account with that address** — create one: email marked verified (the provider just proved it), display name from `name`, **no password**, role left at its default, and `new=1` in the redirect.

Email lookup goes through the existing `auth.normalize_email` and `func.lower()`, because the `User` model's own comment records that `Ivan@Abv.bg` and `ivan@abv.bg` are different strings to both databases.

**Accepted consequence:** a Climby account becomes only as strong as the Google account behind it. That is already true of the password-reset flow.

## New accounts: the role question

Google supplies a name and an email, never whether someone is a student, parent or teacher — and the registration form is where Climby normally learns this.

On `new=1` the app shows one screen — *Which are you?* — with three buttons, then enters the app. One extra tap, and nobody lands in the wrong product by accident; a teacher dropped into the student view sees the wrong screens and may never discover that a setting exists. This screen is also the natural home for the "where did you hear about us" question.

It needs a small authenticated endpoint to set the role.

The account is created as `student` (the model default) and this screen may change it. That grants nothing new: `RegisterRequest.role` already lets any caller choose `student`, `parent` or `teacher` freely, so the OAuth path matches the password path rather than widening it.

## Set a password

Any account without a password gets a *Set a password* option in Settings.

Without it, a student who signs in with a **school** Google account loses Climby entirely when they change school — one route in, controlled by someone else. This is what separates a convenience feature from a trap.

## Errors

The failure that matters most cannot be fixed from inside the app: a school Google Workspace with third-party access locked down returns `access_denied` with `admin_policy_enforced`. Generic handling turns that into "something went wrong", and a twelve-year-old retries forever. It gets its own message: *your school has blocked this — sign in with your email and password.*

| Case | Response |
|---|---|
| User cancels at Google | Return quietly to sign-in. Nothing went wrong. |
| `email_verified` false | Refuse, name the reason, point at the password. |
| `state` missing or mismatched | Refuse. Generic message. |
| Google unreachable / exchange fails | "Couldn't reach Google, try again." |
| Deep link never fires | Portable build only; documented, not worked around. |

`/auth/google/start` and `/auth/google/callback` are rate-limited **by IP**, like every other pre-login route — an account key means nothing before there is an account. The role and set-password endpoints are authenticated, so they are keyed by account like the rest of the signed-in surface.

**A leak deliberately not fixed.** When a Google-only account tries the password form, the natural message — *"this account signs in with Google"* — reveals that the account exists, which five existing tests exist to prevent. It stays the neutral *"Incorrect email or password."* Worse for that one person, right for everyone whose account would otherwise be probeable. Recorded here because it will look like a bug later.

## Testing

ID-token verification sits behind one small function, so tests substitute a decoded token rather than mocking HTTP or calling Google.

- **The takeover test:** an unverified email must never attach to an existing account.
- `subject` matching wins even when the email has changed.
- A new OAuth user has no password and receives `new=1`.
- `state` mismatch is rejected.
- The existing enumeration tests pass unchanged.
- `password_hash` is nullable on a fresh schema.
- Setting a password on a passwordless account works, and then permits password sign-in.

## Rough size

A new `oauth.py` router (~200 lines), the migration step, the identity model, ~80 lines in `desktop/main.js`, the role screen and the buttons in the frontend, and the tests above. Microsoft afterwards is configuration and a second button.

## Prerequisite

Google's consent screen shows who is asking. Without a domain it shows `onrender.com`, and an unverified OAuth app displays *"Google hasn't verified this app"*; verification wants a homepage and a privacy policy at a real address. **A domain should come before this ships** — see `docs/baza-danni.md` for the other reasons one is needed.
