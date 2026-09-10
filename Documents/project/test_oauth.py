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


import migrations  # noqa: E402
import security  # noqa: E402
from db import Base, SessionLocal  # noqa: E402
from models import OAuthIdentity, User  # noqa: E402

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

    Without it, anyone who can make a provider account asserting an address owns
    the Climby account behind it. Nothing else in this file matters as much.
    """
    uid = _existing_password_account()
    db = SessionLocal()
    with pytest.raises(oauth.IdentityRejected):
        oauth.sign_in_with_claims(db, "google", _claims(verified=False))
    assert db.query(OAuthIdentity).count() == 0, "an identity was attached anyway"
    db.close()
    assert uid


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
    again, is_new = oauth.sign_in_with_claims(db, "google", _claims(email="renamed@example.com"))
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
