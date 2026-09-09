# Google Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person sign in to Climby with their Google account, linked safely to any existing account with the same address.

**Architecture:** The app opens the system browser at `/auth/google/start`; the backend drives the OAuth code flow, verifies the ID token against Google's JWKS, applies the linking rules, mints an ordinary Climby JWT, and hands it back to the desktop app through a `climby://auth?t=…` deep link. The client secret never leaves the server.

**Tech Stack:** FastAPI + SQLAlchemy (Postgres in production, SQLite in tests), PyJWT with `cryptography` for RS256, httpx for the token exchange, Electron for the desktop shell, plain JS for the frontend.

**Spec:** `docs/superpowers/specs/2026-09-09-google-sign-in-design.md` — read it before Task 1. The plan argues from it.

## Global Constraints

- **Comments and user-facing strings are English.** The product switched fully in `8870a1f` and `0d5a1d0`. Existing Bulgarian comments in untouched files stay as they are.
- **Never reveal whether an account exists.** Five tests in `test_auth_hardening.py` enforce this. No new message may say "this account signs in with Google" or similar.
- **An unverified provider email must never link to an existing account.** This is the takeover guard, Task 3.
- **Tests run on SQLite, production is Postgres.** Any raw SQL must work on both, or be explicitly guarded by dialect. See `migrations.py` — a `boolean = integer` comparison once crashed Render while passing every local test.
- **`user=user` on rate limits where an account exists**, IP-keyed before login. See `rate_limit._identity`.
- Run the whole suite with `python -m pytest -q` from `Documents/project`. It is **164 passing** before this plan starts.
- Commit after every task. Scope `git add` to explicit paths — the repo root is the home directory and `git add -A` would sweep in unrelated files.

## File Structure

| File | Responsibility |
|---|---|
| `oauth.py` *(new)* | The whole third-party sign-in flow: the two endpoints, ID-token verification, and the linking rules. |
| `test_oauth.py` *(new)* | Tests for all of the above. |
| `models.py` | Gains `OAuthIdentity`; `User.password_hash` becomes nullable. |
| `migrations.py` | Gains one Postgres-guarded step to drop the NOT NULL. |
| `auth.py` | Gains `/auth/role` and `/auth/set-password`. |
| `server.py` | Includes the new router. |
| `requirements.txt` | `pyjwt[crypto]`, `httpx`. |
| `desktop/main.js` | Registers `climby://`, reads it from `argv`, forwards it to the page. |
| `desktop/package.json` | Declares the protocol for electron-builder. |
| `frontend/auth.js` | The Google button, the deep-link receiver, the role screen. |
| `frontend/index.html`, `frontend/i18n.js`, `frontend/style.css` | Markup, strings, styling. |

---

### Task 1: The identity table and the nullable password

**Files:**
- Modify: `models.py`
- Modify: `migrations.py`
- Test: `test_migration.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `models.OAuthIdentity` with columns `id: str`, `user_id: str`, `provider: str`, `subject: str`, `created_at: datetime`, and a unique constraint on `(provider, subject)`. `User.password_hash` becomes `Optional[str]`.

- [ ] **Step 1: Write the failing test**

Append to `test_migration.py`:

```python
def test_an_account_can_exist_without_a_password():
    """A Google-only account has no password, so the column must allow NULL.

    While it was NOT NULL the only way to create such an account was to invent
    a fake hash — a value that looks like a password to every code path that
    reads it, and can never be matched by any input.
    """
    from models import User

    assert User.__table__.c.password_hash.nullable is True


def test_an_oauth_identity_is_keyed_by_provider_and_subject():
    """Two people may share an email over time; a provider subject is forever.

    Keying on the email would fork one person into two accounts the day they
    rename their mailbox.
    """
    from models import OAuthIdentity

    cols = OAuthIdentity.__table__.c
    assert {"id", "user_id", "provider", "subject", "created_at"} <= set(cols.keys())
    uniques = [
        tuple(sorted(c.name for c in con.columns))
        for con in OAuthIdentity.__table__.constraints
        if con.__class__.__name__ == "UniqueConstraint"
    ]
    assert ("provider", "subject") in uniques
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest test_migration.py -k "without_a_password or oauth_identity" -v`
Expected: FAIL — `ImportError: cannot import name 'OAuthIdentity'`, and `nullable is False`.

- [ ] **Step 3: Write minimal implementation**

In `models.py`, change the `User.password_hash` line:

```python
    # NULL means "this account has no password" — it was created through Google
    # and signs in that way. The alternative was a sentinel hash, which reads as
    # a real password to every code path that touches it and matches nothing.
    password_hash = Column(String, nullable=True)
```

Add after the `User` class:

```python
class OAuthIdentity(Base):
    """One third-party identity (Google today, Microsoft later) tied to one account."""

    __tablename__ = "oauth_identities"
    __table_args__ = (UniqueConstraint("provider", "subject", name="uq_oauth_provider_subject"),)

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String, nullable=False)
    # The provider's own permanent id for this person. NOT the email: people
    # rename mailboxes and schools reissue addresses, and matching on the address
    # would quietly create a second account and strand the first.
    subject = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest test_migration.py -k "without_a_password or oauth_identity" -v`
Expected: PASS

- [ ] **Step 5: Add the Postgres migration step**

`metadata.create_all` creates the new table on both databases, so only the dropped constraint needs a step. In `migrations.py`, add this function next to `_add_nullable_column`:

```python
def _drop_password_not_null() -> bool:
    """Let an account exist without a password (Google sign-in).

    Postgres only. SQLite cannot relax a column constraint without rebuilding
    the table, and it does not need to: a fresh test database takes the rule
    from the model definition. A pre-existing local climby.db keeps the old
    NOT NULL, which is harmless because nobody signs in with Google locally.
    """
    if engine.dialect.name != "postgresql":
        return False
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"))
        conn.commit()
    return True
```

Then inside `run()`, alongside the other steps:

```python
        if _tolerantly("users.password_hash:nullable", _drop_password_not_null):
            applied.append("users.password_hash:nullable")
```

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest -q`
Expected: 166 passed (164 before, plus the two new).

- [ ] **Step 7: Commit**

```bash
git add Documents/project/models.py Documents/project/migrations.py Documents/project/test_migration.py
git commit -m "An account can exist without a password"
```

---

### Task 2: Verifying a Google ID token

**Files:**
- Create: `oauth.py`
- Modify: `requirements.txt`
- Test: `test_oauth.py` *(new)*

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `oauth.verify_google_id_token(raw: str) -> dict` returning the decoded claims (`sub`, `email`, `email_verified`, `name`). Raises `oauth.IdentityRejected(message: str)` on any failure. **Tests replace this function; nothing else in the codebase calls Google.**

- [ ] **Step 1: Add the dependencies**

`PyJWT` is installed but **cannot verify RS256** — it delegates to `cryptography`, which is absent, and raises `NotImplementedError`. Google signs ID tokens with RS256. In `requirements.txt`, replace the `pyjwt` line and add httpx:

```
pyjwt[crypto]  # [crypto] pulls in `cryptography`; without it RS256 raises NotImplementedError
httpx  # the Google token exchange; present transitively today, declared here on purpose
```

Then run: `pip install -r requirements.txt`

- [ ] **Step 2: Write the failing test**

Create `test_oauth.py`:

```python
# test_oauth.py — signing in with a Google account.
#
# Run:  python -m pytest test_oauth.py -q
import os
import tempfile

import pytest

_tmp_db = os.path.join(tempfile.mkdtemp(), "oauth.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import oauth  # noqa: E402


def test_a_token_we_cannot_verify_is_rejected_not_trusted():
    """An unverifiable token must raise, never fall through as an empty identity."""
    with pytest.raises(oauth.IdentityRejected):
        oauth.verify_google_id_token("not-a-jwt-at-all")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest test_oauth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'oauth'`

- [ ] **Step 4: Write minimal implementation**

Create `oauth.py`:

```python
# oauth.py — signing in with a third-party account (Google today).
#
# The client secret lives only in the environment and never reaches the app. The
# browser leg happens in the real browser, not an embedded webview: Google
# rejects those outright, precisely so an app cannot read its users' passwords.
import os

import jwt
from jwt import PyJWKClient

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
_GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")

# The keys are fetched once and cached: PyJWKClient handles the refresh when
# Google rotates them.
_jwks_client = PyJWKClient(_GOOGLE_JWKS)


class IdentityRejected(Exception):
    """We could not establish who this is, and will not guess.

    `message` is shown to the person, so it says what to do next rather than
    what went wrong internally.
    """

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def verify_google_id_token(raw: str) -> dict:
    """Decode and verify a Google ID token. The only place we talk to Google.

    Tests replace this whole function rather than mocking HTTP, so the rules
    below are exercised against decoded claims and never against the network.
    """
    try:
        key = _jwks_client.get_signing_key_from_jwt(raw).key
        return jwt.decode(
            raw,
            key,
            algorithms=["RS256"],
            audience=GOOGLE_CLIENT_ID,
            issuer=_GOOGLE_ISSUERS,
        )
    except Exception as err:  # noqa: BLE001 — every failure means the same thing here
        print(f"[oauth] Google ID token rejected: {err!r}", flush=True)
        raise IdentityRejected("We could not confirm your Google account. Please try again.")
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest test_oauth.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add Documents/project/oauth.py Documents/project/test_oauth.py Documents/project/requirements.txt
git commit -m "Verify a Google identity, or refuse to guess at one"
```

---

### Task 3: The linking rules

**Files:**
- Modify: `oauth.py`
- Test: `test_oauth.py`

**Interfaces:**
- Consumes: `oauth.IdentityRejected` (Task 2), `models.OAuthIdentity` (Task 1).
- Produces: `oauth.sign_in_with_claims(db: Session, provider: str, claims: dict) -> tuple[User, bool]` returning `(user, is_new)`. Raises `IdentityRejected` when the provider has not verified the email.

- [ ] **Step 1: Write the failing tests**

Append to `test_oauth.py`:

```python
from db import SessionLocal  # noqa: E402
from models import OAuthIdentity, User  # noqa: E402
import migrations  # noqa: E402
from db import Base  # noqa: E402

migrations.create_schema(Base.metadata)


@pytest.fixture(autouse=True)
def _clean():
    yield
    db = SessionLocal()
    db.query(OAuthIdentity).delete()
    db.query(User).delete()
    db.commit()
    db.close()


def _claims(sub="google-sub-1", email="kid@example.com", verified=True, name="Ivan"):
    return {"sub": sub, "email": email, "email_verified": verified, "name": name}


def _existing_password_account(email="kid@example.com"):
    db = SessionLocal()
    user = User(display_name="Ivan", email=email, password_hash="not-a-real-hash")
    db.add(user)
    db.commit()
    uid = user.id
    db.close()
    return uid


def test_an_unverified_email_never_reaches_an_existing_account():
    """THE takeover guard.

    Without it, anyone who can make a provider account asserting an address
    owns the Climby account behind it. Nothing else in this file matters as
    much as this test.
    """
    uid = _existing_password_account()
    db = SessionLocal()
    with pytest.raises(oauth.IdentityRejected):
        oauth.sign_in_with_claims(db, "google", _claims(verified=False))
    assert db.query(OAuthIdentity).count() == 0, "an identity was attached anyway"
    db.close()
    assert uid  # the account is untouched


def test_a_verified_email_joins_the_account_that_already_exists():
    """The child who forgot their password: same person, same homework."""
    uid = _existing_password_account()
    db = SessionLocal()
    user, is_new = oauth.sign_in_with_claims(db, "google", _claims())
    assert user.id == uid
    assert is_new is False
    db.close()


def test_a_stranger_gets_a_new_account_with_no_password():
    db = SessionLocal()
    user, is_new = oauth.sign_in_with_claims(db, "google", _claims(email="new@example.com"))
    assert is_new is True
    assert user.password_hash is None
    assert user.is_email_verified is True, "the provider already proved the address"
    db.close()


def test_the_subject_wins_when_the_email_has_changed():
    """People rename mailboxes. The provider's subject does not change.

    Matching on the address here would create a second account and leave the
    first one, with all of its history, unreachable.
    """
    db = SessionLocal()
    first, _ = oauth.sign_in_with_claims(db, "google", _claims(email="old@example.com"))
    again, is_new = oauth.sign_in_with_claims(
        db, "google", _claims(email="renamed@example.com"))
    assert again.id == first.id
    assert is_new is False
    db.close()


def test_the_address_is_matched_regardless_of_capitals():
    """Postgres compares text byte by byte; auth.normalize_email exists for this."""
    uid = _existing_password_account(email="kid@example.com")
    db = SessionLocal()
    user, is_new = oauth.sign_in_with_claims(db, "google", _claims(email="Kid@Example.COM"))
    assert user.id == uid
    assert is_new is False
    db.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test_oauth.py -v`
Expected: FAIL — `AttributeError: module 'oauth' has no attribute 'sign_in_with_claims'`

- [ ] **Step 3: Write minimal implementation**

Add these imports to the top of `oauth.py`, with the others, then append the function to the end of the file:

```python
from sqlalchemy.orm import Session

from auth import _email_matches, normalize_email
from models import OAuthIdentity, User


def sign_in_with_claims(db: Session, provider: str, claims: dict) -> tuple:
    """Turn verified provider claims into a Climby account. Returns (user, is_new).

    The order of these branches is the security design, not a convenience:

    1. A known (provider, subject) is this person. It never consults the email,
       so a renamed mailbox changes nothing.
    2. An unverified email is refused outright. This is the takeover guard:
       without it, anyone able to create a provider account claiming an address
       owns the Climby account behind it.
    3. A verified email that matches an existing account joins it. This is the
       case that rescues the child who has forgotten their password.
    4. Anything else is a new account, with no password at all.
    """
    subject = (claims.get("sub") or "").strip()
    if not subject:
        raise IdentityRejected("We could not confirm your Google account. Please try again.")

    identity = (
        db.query(OAuthIdentity)
        .filter(OAuthIdentity.provider == provider, OAuthIdentity.subject == subject)
        .first()
    )
    if identity:
        user = db.query(User).filter(User.id == identity.user_id).first()
        if user:
            return user, False
        # The account was deleted from under the identity; do not resurrect it.
        db.delete(identity)
        db.commit()

    if not claims.get("email_verified"):
        raise IdentityRejected(
            "Google has not confirmed this email address, so we cannot use it to sign in. "
            "Please sign in with your email and password."
        )

    email = normalize_email(claims.get("email") or "")
    if not email:
        raise IdentityRejected("Google did not share an email address with us.")

    user = db.query(User).filter(_email_matches(email)).first()
    is_new = user is None
    if is_new:
        user = User(
            display_name=(claims.get("name") or email.split("@")[0])[:80],
            email=email,
            password_hash=None,
            is_email_verified=True,
        )
        db.add(user)
        db.flush()

    db.add(OAuthIdentity(user_id=user.id, provider=provider, subject=subject))
    db.commit()
    db.refresh(user)
    return user, is_new
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test_oauth.py -v`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the takeover test catches the regression**

Temporarily delete the `if not claims.get("email_verified"):` block and run:

Run: `python -m pytest test_oauth.py::test_an_unverified_email_never_reaches_an_existing_account -v`
Expected: **FAIL.** If it passes, the test is not guarding anything — fix the test before restoring the code.

Restore the block afterwards.

- [ ] **Step 6: Commit**

```bash
git add Documents/project/oauth.py Documents/project/test_oauth.py
git commit -m "An unverified address must never open someone else's account"
```

---

### Task 4: The two endpoints

**Files:**
- Modify: `oauth.py`
- Modify: `server.py`
- Test: `test_oauth.py`

**Interfaces:**
- Consumes: `sign_in_with_claims` (Task 3), `verify_google_id_token` (Task 2).
- Produces: `oauth.router` (an `APIRouter` with no prefix) serving `GET /auth/google/start` and `GET /auth/google/callback`. The callback redirects to `climby://auth?t=<jwt>` with `&new=1` appended only for accounts created in that request.

- [ ] **Step 1: Write the failing tests**

Append to `test_oauth.py`:

```python
from fastapi.testclient import TestClient  # noqa: E402
import server  # noqa: E402

client = TestClient(server.app, follow_redirects=False)


def test_starting_sends_you_to_google_and_remembers_why():
    res = client.get("/auth/google/start")
    assert res.status_code == 307
    assert res.headers["location"].startswith("https://accounts.google.com/")
    assert "climby_oauth_state" in res.cookies, "no state cookie: nothing to check on return"


def test_a_reply_with_the_wrong_state_is_refused():
    """Someone else's callback must not sign you in. This is the CSRF guard."""
    client.cookies.set("climby_oauth_state", "the-state-we-issued")
    res = client.get("/auth/google/callback", params={"code": "x", "state": "a-different-one"})
    assert res.status_code == 400
    client.cookies.clear()


def test_a_school_that_blocks_us_is_told_apart_from_a_broken_app():
    """access_denied + admin_policy_enforced is not "something went wrong".

    A locked-down school Workspace returns exactly this, and a twelve-year-old
    will retry a generic error forever. It has to name what happened.
    """
    res = client.get("/auth/google/callback",
                     params={"error": "access_denied",
                             "error_subtype": "admin_policy_enforced"})
    assert res.status_code == 200
    assert "school" in res.text.lower()


def test_cancelling_at_google_is_not_an_error():
    res = client.get("/auth/google/callback", params={"error": "access_denied"})
    assert res.status_code == 200
    assert "school" not in res.text.lower()


def test_a_successful_callback_hands_the_app_a_token(monkeypatch):
    monkeypatch.setattr(oauth, "verify_google_id_token", lambda raw: _claims(email="cb@example.com"))
    monkeypatch.setattr(oauth, "_exchange_code_for_id_token", lambda code: "pretend-id-token")
    client.cookies.set("climby_oauth_state", "s1")
    res = client.get("/auth/google/callback", params={"code": "x", "state": "s1"})
    assert res.status_code == 307
    assert res.headers["location"].startswith("climby://auth?t=")
    assert "new=1" in res.headers["location"], "a brand-new account must be flagged"
    client.cookies.clear()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test_oauth.py -v`
Expected: FAIL — 404 on `/auth/google/start`.

- [ ] **Step 3: Write minimal implementation**

Append to `oauth.py`:

```python
import secrets
import urllib.parse

import httpx
from fastapi import APIRouter, Depends, Request
from starlette.responses import HTMLResponse, RedirectResponse

import rate_limit
import security
from db import get_db

router = APIRouter(tags=["oauth"])

_STATE_COOKIE = "climby_oauth_state"
_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN = "https://oauth2.googleapis.com/token"

# Where Google sends the browser back. It must match the console entry exactly.
REDIRECT_URI = os.environ.get(
    "GOOGLE_REDIRECT_URI",
    "https://my-project-0gyk.onrender.com/auth/google/callback",
)


def _page(message: str) -> HTMLResponse:
    """The browser tab is a dead end by design — the app is where things happen."""
    return HTMLResponse(
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Climby</title></head>"
        "<body style=\"font:16px/1.5 system-ui;padding:40px;max-width:32em;margin:auto\">"
        f"<p>{message}</p><p>You can close this tab.</p></body></html>"
    )


@router.get("/auth/google/start")
def google_start(request: Request):
    # IP-keyed: there is no account yet, so there is nothing else to key on.
    rate_limit.enforce(request, "oauth-start", max_calls=20, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.")
    state = secrets.token_urlsafe(24)
    query = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        # We want an identity, not an ongoing relationship: no refresh token,
        # no offline access, nothing to store and nothing to leak later.
        "prompt": "select_account",
    })
    response = RedirectResponse(f"{_AUTHORIZE}?{query}")
    response.set_cookie(_STATE_COOKIE, state, httponly=True, secure=True,
                        samesite="lax", max_age=600)
    return response


def _exchange_code_for_id_token(code: str) -> str:
    """Swap the one-time code for an ID token. Replaced wholesale in tests."""
    reply = httpx.post(_TOKEN, timeout=15, data={
        "code": code,
        "client_id": GOOGLE_CLIENT_ID,
        "client_secret": GOOGLE_CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    })
    if reply.status_code != 200:
        print(f"[oauth] token exchange failed: {reply.status_code} {reply.text[:200]}",
              flush=True)
        raise IdentityRejected("We could not reach Google. Please try again.")
    return reply.json().get("id_token", "")


@router.get("/auth/google/callback")
def google_callback(request: Request, code: str = "", state: str = "",
                    error: str = "", error_subtype: str = "",
                    db=Depends(get_db)):
    rate_limit.enforce(request, "oauth-callback", max_calls=30, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.")

    if error:
        # A school Workspace with third-party access switched off lands here, and
        # it is the one failure nobody can fix from inside the app. Told apart
        # from a plain cancel, it becomes a detour instead of a dead end.
        if "admin_policy" in (error_subtype or "") or "admin_policy" in error:
            return _page("Your school has blocked sign-in with Google. "
                         "Please sign in with your email and password instead.")
        return _page("Sign-in was cancelled. Nothing has changed.")

    issued = request.cookies.get(_STATE_COOKIE)
    if not issued or not state or not secrets.compare_digest(issued, state):
        # Either a stale tab or someone else's callback. Both mean: do nothing.
        return _page("This sign-in link has expired. Please try again from Climby.")

    try:
        claims = verify_google_id_token(_exchange_code_for_id_token(code))
        user, is_new = sign_in_with_claims(db, "google", claims)
    except IdentityRejected as rejected:
        return _page(rejected.message)

    token = security.create_access_token(user.id, user.token_version)
    target = f"climby://auth?t={urllib.parse.quote(token)}"
    if is_new:
        target += "&new=1"
    response = RedirectResponse(target)
    response.delete_cookie(_STATE_COOKIE)
    return response
```

In `server.py`, add `import oauth` beside the other imports and include the router next to the rest:

```python
app.include_router(oauth.router)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest test_oauth.py -v`
Expected: PASS, 11 tests.

- [ ] **Step 5: Check the route count did not surprise you**

Run: `python -c "import os; os.environ.setdefault('JWT_SECRET','x'*40); from server import app; print(len(app.openapi()['paths']))"`
Expected: 41 (39 before, plus the two new).

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest -q`
Expected: 177 passed.

- [ ] **Step 7: Commit**

```bash
git add Documents/project/oauth.py Documents/project/server.py Documents/project/test_oauth.py
git commit -m "The two ends of the Google round trip"
```

---

### Task 5: Choosing a role, and setting a password

**Files:**
- Modify: `auth.py`
- Modify: `schemas.py`
- Test: `test_oauth.py`

**Interfaces:**
- Consumes: `auth.get_current_user`, `security.hash_password`.
- Produces: `POST /auth/role` taking `{"role": "student"|"parent"|"teacher"}` and `POST /auth/set-password` taking `{"password": str}`, both authenticated, both returning `{"status": "ok"}`.

- [ ] **Step 1: Write the failing tests**

Append to `test_oauth.py`:

```python
import security  # noqa: E402


def _signed_in_via_google(email="role@example.com", sub="sub-role"):
    db = SessionLocal()
    user, _ = oauth.sign_in_with_claims(db, "google", _claims(sub=sub, email=email))
    token = security.create_access_token(user.id, user.token_version)
    db.close()
    return {"Authorization": f"Bearer {token}"}


def test_a_new_google_account_can_say_who_it_is():
    headers = _signed_in_via_google()
    assert client.post("/auth/role", json={"role": "teacher"}, headers=headers).status_code == 200
    assert client.get("/auth/me", headers=headers).json()["role"] == "teacher"


def test_setting_a_password_gives_a_second_way_in():
    """A school Google account can be taken away. Then this is the only door left."""
    headers = _signed_in_via_google(email="pw@example.com", sub="sub-pw")
    assert client.post("/auth/set-password", json={"password": "brandnew123"},
                       headers=headers).status_code == 200
    signed_in = client.post("/auth/login",
                            json={"email": "pw@example.com", "password": "brandnew123"})
    assert signed_in.status_code == 200


def test_a_password_account_hears_nothing_different_from_a_google_one():
    """Saying "this one uses Google" would tell a stranger the account exists."""
    _existing_password_account(email="quiet@example.com")
    google = client.post("/auth/login", json={"email": "pw@example.com", "password": "wrong"})
    nobody = client.post("/auth/login", json={"email": "nobody@example.com", "password": "wrong"})
    assert google.status_code == nobody.status_code
    assert google.json() == nobody.json()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest test_oauth.py -k "who_it_is or second_way or nothing_different" -v`
Expected: FAIL — 404 on `/auth/role`.

- [ ] **Step 3: Add the request schemas**

In `schemas.py`, beside the other request models:

```python
class RoleRequest(BaseModel):
    role: Literal["student", "parent", "teacher"]


class SetPasswordRequest(BaseModel):
    password: str = Field(min_length=8, max_length=128)
```

- [ ] **Step 4: Write the endpoints**

In `auth.py`, add `RoleRequest, SetPasswordRequest` to the `from schemas import (...)` list, then append:

```python
@router.post("/role")
def set_role(body: RoleRequest, request: Request,
             user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Which of the three this person is.

    Google tells us a name and an address, never a role, so an account created
    that way needs to be asked once. This grants nothing new: RegisterRequest
    already lets any caller choose freely, so this matches the password path
    rather than widening it.
    """
    rate_limit.enforce(request, "set-role", max_calls=10, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.",
                       user=user)
    user.role = body.role
    db.commit()
    return {"status": "ok"}


@router.post("/set-password")
def set_password(body: SetPasswordRequest, request: Request,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """A second way in, for an account that has only had one.

    A student who signs in with a school Google account loses it when they
    change school. Without this, their homework goes with it.
    """
    rate_limit.enforce(request, "set-password", max_calls=5, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.",
                       user=user)
    user.password_hash = security.hash_password(body.password)
    # Every existing session stays valid: nothing was compromised, someone just
    # gained a second key. Bumping token_version here would sign them out of the
    # device they are holding, for doing the safe thing.
    db.commit()
    return {"status": "ok"}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest test_oauth.py -v`
Expected: PASS, 14 tests.

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest -q`
Expected: 180 passed. **If any `test_auth_hardening.py` test fails, stop** — an enumeration guard has been broken and that is more important than this feature.

- [ ] **Step 7: Commit**

```bash
git add Documents/project/auth.py Documents/project/schemas.py Documents/project/test_oauth.py
git commit -m "Say who you are, and keep a spare key"
```

---

### Task 6: The desktop deep link

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/package.json`

**Interfaces:**
- Consumes: the `climby://auth?t=…` URL produced by Task 4.
- Produces: `window.CLIMBY_DESKTOP.onSignIn(handler)`, calling `handler({ token: string, isNew: boolean })`.

- [ ] **Step 1: Declare the protocol for the installer**

In `desktop/package.json`, inside `build`, beside `win`:

```json
    "protocols": [
      {
        "name": "Climby",
        "schemes": ["climby"]
      }
    ],
```

- [ ] **Step 2: Register the scheme at runtime**

In `desktop/main.js`, inside the `else` branch that already holds `gotLock`, before `app.whenReady()`:

```js
  // Windows hands a climby:// link to whichever program claims the scheme. The
  // installer records the claim; this covers the development run, where there is
  // no installer, and repairs the entry if another program took it.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('climby', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('climby');
  }
```

- [ ] **Step 3: Read the link out of argv**

Still in `main.js`, replace the existing `second-instance` handler:

```js
  // A climby:// link starts a SECOND copy of the app, which the single-instance
  // lock immediately shuts down — but Windows hands that copy the URL first, and
  // it arrives here on the running one. Without this the link would open a window
  // and lose the token silently.
  app.on('second-instance', (event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const deepLink = argv.find(arg => arg.startsWith('climby://'));
    if (deepLink) forwardSignIn(deepLink);
  });

  // macOS delivers it as an event rather than an argument. Cheap to support and
  // wrong to leave out.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    forwardSignIn(url);
  });

  function forwardSignIn(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return; // an unparseable link is not a sign-in
    }
    if (parsed.host !== 'auth' && parsed.pathname !== '//auth') return;
    const token = parsed.searchParams.get('t');
    if (!token) return;
    if (mainWindow) {
      mainWindow.webContents.send('climby:auth-token', {
        token,
        isNew: parsed.searchParams.get('new') === '1',
      });
    }
  }
```

- [ ] **Step 4: Hand it to the page**

The renderer has `nodeIntegration: false`, so it cannot receive IPC directly. **`desktop/preload.js` already exists** and already exposes a bridge called `CLIMBY_DESKTOP` (main.js:55 already loads it). Extend that object rather than adding a second global:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CLIMBY_DESKTOP', {
  isDesktop: true,
  platform: process.platform,
  // Called once by auth.js. The page never receives the raw ipcRenderer — it
  // gets one callback and nothing else to misuse.
  onSignIn: handler => ipcRenderer.on('climby:auth-token', (_event, payload) => handler(payload)),
});
```

`main.js:55` already loads this file, so nothing changes in `createWindow`.

- [ ] **Step 5: Verify by hand**

There is no automated test for this; Electron protocol registration needs a real OS. Run:

```bash
cd desktop && npx electron .
```

Then, from another terminal: `start climby://auth?t=abc123&new=1`

Expected: the running Climby window comes to the front. Open its DevTools console and confirm no error; with Task 7 in place the token would be consumed here.

- [ ] **Step 6: Commit**

```bash
git add Documents/project/desktop/main.js Documents/project/desktop/package.json Documents/project/desktop/preload.js
git commit -m "Catch the link Google sends us home with"
```

---

### Task 7: The buttons, the token, and the role screen

**Files:**
- Modify: `frontend/auth.js`
- Modify: `frontend/index.html`
- Modify: `frontend/i18n.js`
- Modify: `frontend/style.css`
- Modify: `frontend/sw.js`
- Test: `test_frontend_checks.py`

**Interfaces:**
- Consumes: `window.CLIMBY_DESKTOP.onSignIn` (Task 6), `POST /auth/role` (Task 5), `GET /auth/me`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

The frontend has static checks rather than a browser harness. Append to `test_frontend_checks.py`:

```python
def test_every_new_string_exists_in_both_languages():
    """A key present in one language and missing in the other is a blank screen."""
    import re
    source = open(os.path.join(FRONTEND, "i18n.js"), encoding="utf-8").read()
    for key in ("auth.google", "auth.roleTitle", "auth.roleStudent",
                "auth.roleParent", "auth.roleTeacher", "auth.googleFailed"):
        assert source.count(f"'{key}'") >= 2, f"{key} is missing from a language"


def test_the_google_button_exists_and_is_wired():
    html = open(os.path.join(FRONTEND, "index.html"), encoding="utf-8").read()
    js = open(os.path.join(FRONTEND, "auth.js"), encoding="utf-8").read()
    assert 'id="googleSignIn"' in html
    assert "googleSignIn" in js, "the button exists but nothing listens to it"
```

Check the constant name for the frontend directory at the top of `test_frontend_checks.py` and use whatever it is (it may be `FRONTEND` or a `Path`).

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest test_frontend_checks.py -k "both_languages or google_button" -v`
Expected: FAIL

- [ ] **Step 3: Add the strings**

In `frontend/i18n.js`, add to **both** the `bg` and `en` tables:

```js
      'auth.google': 'Continue with Google',
      'auth.googleFailed': 'Google sign-in did not work. Try your email and password.',
      'auth.roleTitle': 'Which are you?',
      'auth.roleStudent': 'Student',
      'auth.roleParent': 'Parent',
      'auth.roleTeacher': 'Teacher',
```

Bulgarian:

```js
      'auth.google': 'Продължи с Google',
      'auth.googleFailed': 'Влизането с Google не стана. Опитай с имейл и парола.',
      'auth.roleTitle': 'Ти кой си?',
      'auth.roleStudent': 'Ученик',
      'auth.roleParent': 'Родител',
      'auth.roleTeacher': 'Учител',
```

- [ ] **Step 4: Add the markup**

In `frontend/index.html`, inside `#loginForm` after the `#loginBtn` button:

```html
      <div class="auth-or"><span data-i18n="auth.or">or</span></div>
      <button id="googleSignIn" class="btn-secondary btn-google" type="button">
        <span data-i18n="auth.google">Continue with Google</span>
      </button>
```

And after the `#verifyForm` block, a new hidden screen:

```html
    <div id="roleForm" class="auth-form hidden">
      <h2 data-i18n="auth.roleTitle">Which are you?</h2>
      <button class="btn-primary role-choice" type="button" data-role="student"
              data-i18n="auth.roleStudent">Student</button>
      <button class="btn-secondary role-choice" type="button" data-role="parent"
              data-i18n="auth.roleParent">Parent</button>
      <button class="btn-secondary role-choice" type="button" data-role="teacher"
              data-i18n="auth.roleTeacher">Teacher</button>
    </div>
```

Add `'auth.or': 'or'` / `'auth.or': 'или'` to both language tables as well.

- [ ] **Step 5: Wire it up**

In `frontend/auth.js`, inside the module before `return {`:

```js
  // The browser leg has to happen in the real browser: Google refuses to run its
  // consent screen inside an embedded webview, so an in-app window would only
  // ever show an error.
  function startGoogle() {
    window.open(BACKEND + '/auth/google/start', '_blank');
  }

  // The desktop shell catches climby://auth and hands the token here.
  function receiveDesktopSignIn(payload) {
    if (!payload || !payload.token) return;
    fetch(BACKEND + '/auth/me', { headers: { Authorization: 'Bearer ' + payload.token } })
      .then(res => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(user => {
        _setSession(payload.token, user, true);
        if (payload.isNew) showRoleChoice();
        else hideEntryGate();
      })
      .catch(() => setError(window.t ? t('auth.googleFailed') : 'Google sign-in did not work.'));
  }

  function showRoleChoice() {
    ['loginForm', 'registerForm', 'verifyForm'].forEach(id => $(id) && $(id).classList.add('hidden'));
    $('roleForm').classList.remove('hidden');
  }

  function chooseRole(role) {
    fetch(BACKEND + '/auth/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify({ role }),
    }).finally(() => {
      const user = getUser() || {};
      user.role = role;
      const store = localStorage.getItem(TOKEN_KEY) ? localStorage : sessionStorage;
      store.setItem(USER_KEY, JSON.stringify(user));
      hideEntryGate();
      window.dispatchEvent(new CustomEvent('climby:auth-changed', { detail: { loggedIn: true, user } }));
    });
  }
```

Inside `init()`, alongside the other listeners:

```js
    if ($('googleSignIn')) $('googleSignIn').addEventListener('click', startGoogle);
    document.querySelectorAll('.role-choice').forEach(btn => {
      btn.addEventListener('click', () => chooseRole(btn.dataset.role));
    });
    if (window.CLIMBY_DESKTOP && window.CLIMBY_DESKTOP.onSignIn) {
      window.CLIMBY_DESKTOP.onSignIn(receiveDesktopSignIn);
    }
```

`setError(msg, kind)` (auth.js:140) shows the message — anything other than `'success'` renders it as an error, so one argument is enough. `hideEntryGate` is at auth.js:47. Both already exist; do not invent new ones.

- [ ] **Step 6: Style the button**

In `frontend/style.css`:

```css
/* The divider says "there is another way", without implying one is the real one. */
.auth-or {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0 12px;
  color: var(--text-dim);
  font-size: 13px;
}
.auth-or::before, .auth-or::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}
.btn-google { width: 100%; }
.role-choice { width: 100%; margin-bottom: 10px; }
```

`--text-dim` and `--border` are the real token names (style.css:17-18 for dark, :113-114 for light). There is no `--text-soft` or `--line`.

- [ ] **Step 7: Bump the service worker cache**

`frontend/sw.js` serves images cache-first and the shell by version. Any change to these files needs the version raised or returning users keep the old page:

```js
const CACHE = 'climby-shell-v15';
```

It is at `v14` today (sw.js:20). Raising it is what makes returning users receive the new page instead of the cached one.

- [ ] **Step 8: Run the tests**

Run: `python -m pytest test_frontend_checks.py -q`
Expected: PASS

- [ ] **Step 9: Verify by hand in a browser**

```bash
python -m uvicorn server:app --port 8000
cd frontend && python -m http.server 8003
```

Open `http://127.0.0.1:8003/index.html`. Expected: the Google button renders under the sign-in form in both languages and both themes, the layout does not overflow at 360px wide, and the console is clean. The button will not complete a sign-in until Task 8 supplies credentials.

- [ ] **Step 10: Commit**

```bash
git add Documents/project/frontend/auth.js Documents/project/frontend/index.html Documents/project/frontend/i18n.js Documents/project/frontend/style.css Documents/project/frontend/sw.js Documents/project/test_frontend_checks.py
git commit -m "A second door on the sign-in screen"
```

---

### Task 8: Credentials, and telling people how

**Files:**
- Create: `docs/google-sign-in.md`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing in code.

- [ ] **Step 1: Write the setup document**

Create `docs/google-sign-in.md`:

```markdown
# Turning on Google sign-in

## What you need first

**A domain.** Google's consent screen shows who is asking; without one it shows
`onrender.com`, and an unverified app displays "Google hasn't verified this app".
For a product aimed at children that is the worst possible first impression.

## In the Google Cloud console

1. Create a project. **APIs & Services → OAuth consent screen** → External.
2. App name `Climby`, your support email, your domain, a privacy policy URL.
3. Scopes: `openid`, `email`, `profile`. Nothing else — we never call a Google API.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
5. Authorised redirect URI, exactly:
   `https://my-project-0gyk.onrender.com/auth/google/callback`
   A trailing slash makes it a different URI and the sign-in fails with
   `redirect_uri_mismatch`.
6. Copy the client ID and client secret.

## In Render

**Environment**, then a deploy:

    GOOGLE_CLIENT_ID = <the client id>
    GOOGLE_CLIENT_SECRET = <the client secret>
    GOOGLE_REDIRECT_URI = https://my-project-0gyk.onrender.com/auth/google/callback

The secret belongs only here. It is never in the repository and never in the app.

## Checking it works

1. `curl -s https://my-project-0gyk.onrender.com/auth/google/start -i | head -3`
   Expected: `307` and a `location` starting `https://accounts.google.com/`.
2. In the installed desktop app, press **Continue with Google**.

## What will not work, and why

- **The portable build.** It cannot register the `climby://` scheme, the same
  reason it cannot self-update. The password path still works there.
- **Some school accounts.** A Google Workspace for Education tenant can block
  third-party apps, and many do by default. Those people see "your school has
  blocked this" and should use a password. This is not something the app can
  fix.
```

- [ ] **Step 2: Link it and record the variables**

In `README.md`, in the notes list beside the other docs:

```markdown
- [`docs/google-sign-in.md`](docs/google-sign-in.md) — what to create in Google's
  console, what to set in Render, and who it will not work for.
```

In `.env.example`:

```
# Google sign-in. Both come from the Google Cloud console; see docs/google-sign-in.md.
# Without them the Google button is present but every attempt fails.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
```

- [ ] **Step 3: Run the full suite one last time**

Run: `python -m pytest -q`
Expected: 182 passed (164 at the start, plus 18 across these tasks).

- [ ] **Step 4: Commit**

```bash
git add Documents/project/docs/google-sign-in.md Documents/project/README.md Documents/project/.env.example
git commit -m "How to switch Google sign-in on, and who it will not serve"
```

---

## After the plan

**Deploy:** Render → `my-project` → Manual Deploy → Deploy latest commit. Auto-deploy is off.

**Desktop:** the deep link ships in the app bundle, so it needs a new build and a reinstall. Existing v1.0.7 installs will show the button and fail at the last step until then — consider hiding the button when `window.CLIMBY_DESKTOP` exists but `onSignIn` does not — that combination is exactly an old build.

**Then Microsoft:** the same flow with different URLs. `oauth.py` already takes `provider` as a parameter and `oauth_identities` already keys on it, so it is a second `verify_*` function, a second pair of endpoints, and a second button.
