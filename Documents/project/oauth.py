# oauth.py — signing in with a third-party account (Google today, Microsoft later).
#
# The client secret lives only in the environment and never reaches the app. The
# browser leg happens in the real browser, not an embedded webview: Google rejects
# those outright, precisely so that an app cannot read its users' passwords.
import os

import jwt
from jwt import PyJWKClient
from sqlalchemy.orm import Session

from auth import _email_matches, normalize_email
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
