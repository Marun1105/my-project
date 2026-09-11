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


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    """Most tests here describe a server that HAS credentials."""
    monkeypatch.setattr(oauth, "GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setattr(oauth, "GOOGLE_CLIENT_SECRET", "test-client-secret")
    yield


def test_a_server_without_credentials_says_so_instead_of_offering():
    """The app asks before it shows the button."""
    oauth.GOOGLE_CLIENT_ID = ""
    try:
        assert client.get("/auth/providers").json() == {"google": False}
    finally:
        oauth.GOOGLE_CLIENT_ID = "test-client-id"


def test_a_configured_server_offers_google():
    assert client.get("/auth/providers").json() == {"google": True}


def test_pressing_the_button_on_an_unconfigured_server_blames_nobody(monkeypatch):
    """Not a redirect into one of Google's own error pages, which reads as
    "Climby is broken" rather than "this is switched off here"."""
    monkeypatch.setattr(oauth, "GOOGLE_CLIENT_ID", "")
    res = client.get("/auth/google/start")
    assert res.status_code == 503
    assert "not available" in res.text.lower()


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


def test_a_spare_key_is_only_for_a_lock_that_has_none():
    """set-password must not become a password change without the old password.

    For a Google-only account there is nothing to prove and this is the whole
    point. For an account that already has a password, allowing it would turn a
    stolen token into a permanent takeover — the attacker locks the owner out
    without ever knowing the original. Changing a known password goes through
    the reset flow, which proves the mailbox.
    """
    _existing_password_account(email="haspw@example.com")
    db = SessionLocal()
    user = db.query(User).filter(User.email == "haspw@example.com").first()
    headers = {"Authorization": f"Bearer {security.create_access_token(user.id, user.token_version)}"}
    db.close()

    res = client.post("/auth/set-password", json={"password": "attackerchosen1"}, headers=headers)
    assert res.status_code == 400, "an account with a password must not be overwritten this way"


def test_the_app_only_accepts_a_sign_in_it_asked_for(monkeypatch):
    """A climby:// link is a message anyone can send.

    Without a value the app itself chose, a link mailed to a child signs their
    Climby into someone else's account — and their homework, their questions and
    their history are then written into a stranger's profile. The app sends a
    nonce with the request and the deep link has to carry it back.
    """
    monkeypatch.setattr(oauth, "verify_google_id_token", lambda raw: _claims(email="nonce@example.com"))
    monkeypatch.setattr(oauth, "_exchange_code_for_id_token", lambda code: "pretend-id-token")

    started = client.get("/auth/google/start", params={"app": "app-nonce-xyz"})
    assert started.status_code == 307
    res = client.get("/auth/google/callback", params={"code": "x", "state": "ignored"})
    client.cookies.clear()
    # The state cookie has to remember the app's nonce, not just Google's state.
    assert "app-nonce-xyz" in started.cookies["climby_oauth_state"]


def test_the_deep_link_carries_the_nonce_home(monkeypatch):
    monkeypatch.setattr(oauth, "verify_google_id_token", lambda raw: _claims(email="nonce2@example.com"))
    monkeypatch.setattr(oauth, "_exchange_code_for_id_token", lambda code: "pretend-id-token")
    client.cookies.set("climby_oauth_state", "st4te.app-nonce-abc")
    res = client.get("/auth/google/callback", params={"code": "x", "state": "st4te"})
    client.cookies.clear()
    assert res.status_code == 307
    assert "n=app-nonce-abc" in res.headers["location"], res.headers["location"]


def test_an_unproven_account_cannot_capture_someone_who_proves_the_address():
    """Registration creates the row BEFORE the mailbox is proven.

    So anyone can register victim@school.org and sit on it. If Google sign-in
    simply joined whatever row matched the address, the victim would be signed
    into the squatter's account — the squatter's name, and every question the
    victim asks afterwards readable by them. Google proved the mailbox; the
    password holder never did, so the proven owner takes the row and the
    unproven password stops working.
    """
    client.post("/auth/register", json={
        "display_name": "Squatter", "email": "victim@school.org", "password": "squatter123",
    })
    db = SessionLocal()
    squatted = db.query(User).filter(User.email == "victim@school.org").first()
    assert squatted is not None and squatted.is_email_verified is False
    db.close()

    db = SessionLocal()
    user, is_new = oauth.sign_in_with_claims(
        db, "google", _claims(sub="sub-victim", email="victim@school.org"))
    assert user.is_email_verified is True, "joining must prove the address, not inherit a lie"
    assert user.password_hash is None, "the unproven password must stop working"
    db.close()

    # And the squatter's password no longer opens it.
    refused = client.post("/auth/login",
                          json={"email": "victim@school.org", "password": "squatter123"})
    assert refused.status_code == 401


def test_joining_a_proven_account_leaves_its_password_alone():
    """The ordinary case: a real person who verified, then adds Google."""
    db = SessionLocal()
    user = User(display_name="Real", email="real@example.com",
                password_hash="a-real-looking-hash", is_email_verified=True)
    db.add(user)
    db.commit()
    db.close()

    db = SessionLocal()
    joined, is_new = oauth.sign_in_with_claims(
        db, "google", _claims(sub="sub-real", email="real@example.com"))
    assert is_new is False
    assert joined.password_hash == "a-real-looking-hash", "a proven password must survive"
    db.close()
