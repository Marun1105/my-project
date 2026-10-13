# -*- coding: utf-8 -*-
# test_social_http.py — the friend code over a real request.
#
# The rest of the social tests call the handlers directly, which is fine for
# logic and useless for this one thing: the rate limit only exists if FastAPI
# actually hands the endpoint a Request. `request: Request = None` is exactly
# the shape that silently does nothing when it is wrong, so it is checked here
# through the app rather than around it.
#
# Run:  python -m pytest test_social_http.py -q
import os
import tempfile
import uuid

_tmp_db = os.path.join(tempfile.mkdtemp(), "social_http.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import User  # noqa: E402

client = TestClient(server.app)


def _account():
    email = f"http-{uuid.uuid4().hex[:10]}@example.com"
    rate_limit._hits.clear()
    assert client.post("/auth/register", json={
        "display_name": "К", "email": email, "password": "testpass123",
    }).status_code == 200
    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    user.is_email_verified = True
    db.commit()
    db.close()
    rate_limit._hits.clear()
    res = client.post("/auth/login", json={"email": email, "password": "testpass123"})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def test_guessing_codes_is_stopped_before_a_thousand_tries():
    """Six characters from an alphabet of 32 is about a billion — plenty
    against a person, nothing against a script left running overnight. The cap
    is what makes the code safe, so it is the thing that gets tested."""
    headers = _account()
    rate_limit._hits.clear()
    statuses = [client.post(f"/social/friends/code/ZZZZZ{n % 10}", headers=headers).status_code
                for n in range(30)]
    assert 429 in statuses, "codes can be tried as fast as the network allows"
    assert statuses.index(429) <= 21, "the cap is higher than it was meant to be"


def test_a_real_code_still_works_within_the_cap():
    a = _account()
    b = _account()
    rate_limit._hits.clear()
    code = client.get("/social/me", headers=b).json()["friend_code"]
    res = client.post(f"/social/friends/code/{code}", headers=a)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "pending"


def test_the_pending_request_i_sent_names_nobody():
    """The same rule as the unit test, asserted on the wire: what comes back
    over HTTP is what a guesser would actually get."""
    a = _account()
    b = _account()
    rate_limit._hits.clear()
    code = client.get("/social/me", headers=b).json()["friend_code"]
    client.post(f"/social/friends/code/{code}", headers=a)

    pending = client.get("/social/friends", headers=a).json()["pending"]
    assert pending and set(pending[0]) == {"link_id", "they_asked"}
    assert pending[0]["they_asked"] is False
