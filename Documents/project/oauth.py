# oauth.py — signing in with a third-party account (Google today, Microsoft later).
#
# The client secret lives only in the environment and never reaches the app. The
# browser leg happens in the real browser, not an embedded webview: Google rejects
# those outright, precisely so that an app cannot read its users' passwords.
import os

import jwt
from jwt import PyJWKClient

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
