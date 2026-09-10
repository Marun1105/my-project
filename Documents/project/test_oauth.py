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
                     params={"error": "access_denied", "error_subtype": "admin_policy_enforced"})
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


def test_a_google_account_hears_nothing_different_from_a_stranger():
    """Saying "this one uses Google" would tell a stranger the account exists."""
    _signed_in_via_google(email="quiet@example.com", sub="sub-quiet")
    google = client.post("/auth/login", json={"email": "quiet@example.com", "password": "wrong"})
    nobody = client.post("/auth/login", json={"email": "nobody@example.com", "password": "wrong"})
    assert google.status_code == nobody.status_code
    assert google.json() == nobody.json()
