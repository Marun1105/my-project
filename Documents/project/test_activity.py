# test_activity.py — the home screen's one request: every moment of effort.
#
# Run:  python -m pytest test_activity.py -q
import os
import tempfile
from datetime import date, datetime, timedelta, timezone

_tmp_db = os.path.join(tempfile.mkdtemp(), "activity.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import FocusSession, ScanHistory, Task, User  # noqa: E402

client = TestClient(server.app)


def _login(email):
    rate_limit._hits.clear()
    client.post("/auth/register", json={"display_name": "A", "email": email, "password": "testpass123"})
    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    user.is_email_verified = True
    db.commit()
    uid = user.id
    db.close()
    res = client.post("/auth/login", json={"email": email, "password": "testpass123"})
    assert res.status_code == 200, res.text
    return uid, {"Authorization": f"Bearer {res.json()['token']}"}


def _seed(uid, days_ago, questions=0, session_seconds=0, tasks_done=0):
    """Plant effort on a given day, directly in the database."""
    at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    db = SessionLocal()
    for _ in range(questions):
        db.add(ScanHistory(user_id=uid, question="q", answer="a", created_at=at))
    if session_seconds:
        db.add(FocusSession(user_id=uid, duration_seconds=session_seconds, created_at=at))
    for _ in range(tasks_done):
        db.add(Task(user_id=uid, text="t", done=True, completed_at=at))
    db.commit()
    db.close()


def test_it_needs_a_login():
    assert client.get("/activity").status_code == 401


def test_every_kind_of_effort_is_one_event():
    uid, h = _login("kinds@example.com")
    _seed(uid, 0, questions=2, session_seconds=900, tasks_done=1)
    res = client.get("/activity", headers=h)
    assert res.status_code == 200
    kinds = sorted(e["kind"] for e in res.json()["events"])
    assert kinds == ["question", "question", "session", "task"]
    session = next(e for e in res.json()["events"] if e["kind"] == "session")
    assert session["seconds"] == 900


def test_a_daily_user_is_not_capped_at_the_list_limits():
    """The reason this endpoint exists.

    /scans returns the last 50 questions. A student asking five a day would
    see ten days of history there, and a streak built from it stopped at two
    weeks no matter how long they had really kept it up.
    """
    uid, h = _login("daily@example.com")
    for d in range(60):
        _seed(uid, d, questions=5)
    events = client.get("/activity", headers=h).json()["events"]
    assert len(events) == 300, "every question in the window, not the last fifty"
    days = {e["at"][:10] for e in events}
    assert len(days) == 60


def test_the_window_has_an_edge():
    uid, h = _login("old@example.com")
    _seed(uid, 200, questions=1)   # outside the window
    _seed(uid, 3, questions=1)     # inside
    assert len(client.get("/activity", headers=h).json()["events"]) == 1


def test_a_short_session_does_not_count():
    """Same rule as the sessions list: under a minute is noise, not effort."""
    uid, h = _login("short@example.com")
    _seed(uid, 0, session_seconds=30)
    assert client.get("/activity", headers=h).json()["events"] == []


def test_due_today_uses_the_clients_day():
    uid, h = _login("due@example.com")
    db = SessionLocal()
    db.add(Task(user_id=uid, text="today", deadline=date(2030, 5, 20)))
    db.add(Task(user_id=uid, text="done already", deadline=date(2030, 5, 20), done=True))
    db.add(Task(user_id=uid, text="tomorrow", deadline=date(2030, 5, 21)))
    db.commit()
    db.close()
    assert client.get("/activity?today=2030-05-20", headers=h).json()["due_today"] == 1
    assert client.get("/activity?today=2030-05-21", headers=h).json()["due_today"] == 1
    assert client.get("/activity?today=2030-05-22", headers=h).json()["due_today"] == 0


def test_one_students_effort_never_shows_on_anothers_screen():
    a, ha = _login("a@example.com")
    b, hb = _login("b@example.com")
    _seed(a, 0, questions=3)
    assert client.get("/activity", headers=hb).json()["events"] == []
    assert len(client.get("/activity", headers=ha).json()["events"]) == 3


def test_every_timestamp_says_which_zone_it_is_in():
    """A bare ISO string is read by a browser as local time.

    SQLite returns naive datetimes; a UTC moment sent without a suffix moves
    by the time-zone offset on the client and can land on the wrong day.
    """
    uid, h = _login("tz@example.com")
    _seed(uid, 0, questions=1)
    at = client.get("/activity", headers=h).json()["events"][0]["at"]
    assert at.endswith("Z") or "+00:00" in at, at
