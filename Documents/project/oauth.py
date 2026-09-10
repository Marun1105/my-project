# oauth.py — signing in with a third-party account (Google today, Microsoft later).
#
# The client secret lives only in the environment and never reaches the app. The
# browser leg happens in the real browser, not an embedded webview: Google rejects
# those outright, precisely so that an app cannot read its users' passwords.
import os

import re
import secrets
import urllib.parse

import httpx
import jwt
from fastapi import APIRouter, Depends, Request
from jwt import PyJWKClient
from sqlalchemy.orm import Session
from starlette.responses import HTMLResponse, RedirectResponse

import rate_limit
import security
from auth import _email_matches, normalize_email
from db import get_db
from models import OAuthIdentity, User

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
_GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")

# The keys are fetched on first use and cached; PyJWKClient refreshes them when
# Google rotates. Constructing it here costs nothing and touches no network.
_jwks_client = PyJWKClient(_GOOGLE_JWKS)


class IdentityRejected(Exception):
    """We could not establish who this is, and will not guess.

    `message` is shown to the person, so it says what to do next rather than what
    went wrong internally. The detail goes to the log, where it belongs.
    """

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def verify_google_id_token(raw: str) -> dict:
    """Decode and verify a Google ID token. The only place we talk to Google.

    Tests replace this whole function rather than mocking HTTP, so every rule
    below it is exercised against decoded claims and never against the network.
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
    except Exception as err:  # noqa: BLE001 — every failure here means the same thing
        print(f"[oauth] Google ID token rejected: {err!r}", flush=True)
        raise IdentityRejected("We could not confirm your Google account. Please try again.")


def sign_in_with_claims(db: Session, provider: str, claims: dict) -> tuple:
    """Turn verified provider claims into a Climby account. Returns (user, is_new).

    The order of these branches is the security design, not a convenience:

    1. A known (provider, subject) is this person. It never consults the email, so
       a renamed mailbox changes nothing.
    2. An unverified email is refused outright. This is the takeover guard:
       without it, anyone able to create a provider account claiming an address
       owns the Climby account behind it.
    3. A verified email matching an existing account joins it. This is the case
       that rescues the child who has forgotten their password.
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
        # The account was deleted from under the identity. Do not resurrect it.
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


router = APIRouter(tags=["oauth"])

_STATE_COOKIE = "climby_oauth_state"
_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN = "https://oauth2.googleapis.com/token"

# Where Google sends the browser back. It must match the console entry exactly —
# even a trailing slash makes it a different URI and the sign-in fails.
REDIRECT_URI = os.environ.get(
    "GOOGLE_REDIRECT_URI",
    "https://my-project-0gyk.onrender.com/auth/google/callback",
)


def _page(message: str, status: int = 200) -> HTMLResponse:
    """The browser tab is a dead end by design — the app is where things happen.

    Status matters: a cancelled sign-in is not an error, someone else's callback
    is. Both are shown as a sentence rather than a stack trace, because the
    reader is a child looking at a browser tab.
    """
    return HTMLResponse(
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Climby</title></head>"
        "<body style=\"font:16px/1.5 system-ui;padding:40px;max-width:32em;margin:auto\">"
        f"<p>{message}</p><p>You can close this tab.</p></body></html>",
        status_code=status,
    )


# Only these characters may travel in the nonce. It ends up in a cookie and in a
# URL, and a nonce is a random value we generated — anything else is someone
# else's idea and does not belong in either place.
_SAFE_NONCE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@router.get("/auth/google/start")
def google_start(request: Request, app: str = ""):
    # IP-keyed: there is no account yet, so there is nothing else to key on.
    rate_limit.enforce(request, "oauth-start", max_calls=20, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.")
    state = secrets.token_urlsafe(24)
    query = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        # We want an identity, not an ongoing relationship: no offline access, no
        # refresh token, nothing to store and nothing to leak later.
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    })
    response = RedirectResponse(f"{_AUTHORIZE}?{query}")
    # The cookie remembers two different things. `state` proves the reply came
    # from the browser leg we started. `app` proves it belongs to the copy of
    # Climby that asked — without it, a climby:// link mailed to a child signs
    # their app into whichever account the sender chose, and everything they do
    # afterwards is written into a stranger's profile.
    remembered = state if not _SAFE_NONCE.match(app or "") else f"{state}.{app}"
    response.set_cookie(_STATE_COOKIE, remembered, httponly=True, secure=True,
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
        print(f"[oauth] token exchange failed: {reply.status_code} {reply.text[:200]}", flush=True)
        raise IdentityRejected("We could not reach Google. Please try again.")
    return reply.json().get("id_token", "")


@router.get("/auth/google/callback")
def google_callback(request: Request, code: str = "", state: str = "",
                    error: str = "", error_subtype: str = "",
                    db: Session = Depends(get_db)):
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

    remembered = request.cookies.get(_STATE_COOKIE) or ""
    issued, _, app_nonce = remembered.partition(".")
    if not issued or not state or not secrets.compare_digest(issued, state):
        # Either a stale tab or somebody else's callback. Both mean: do nothing.
        return _page("This sign-in link has expired. Please try again from Climby.", status=400)

    try:
        claims = verify_google_id_token(_exchange_code_for_id_token(code))
        user, is_new = sign_in_with_claims(db, "google", claims)
    except IdentityRejected as rejected:
        return _page(rejected.message, status=400)

    token = security.create_access_token(user.id, user.token_version)
    target = f"climby://auth?t={urllib.parse.quote(token)}"
    if is_new:
        target += "&new=1"
    if _SAFE_NONCE.match(app_nonce or ""):
        target += f"&n={app_nonce}"
    response = RedirectResponse(target)
    response.delete_cookie(_STATE_COOKIE)
    return response
