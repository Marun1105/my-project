# -*- coding: utf-8 -*-
# test_guest_briefs.py — the briefs nobody owns.
#
# A ProblemBrief holds what the reader made of a photographed homework page.
# One with a user_id is reachable: /account/export returns it and deleting the
# account deletes it. One without — every guest's — was reachable by neither,
# so it stayed in Neon for good and no part of the app could remove it. That is
# the whole of this file: the ownerless ones go, the owned ones stay.
#
# Run:  python -m pytest test_guest_briefs.py -q
import os
import tempfile
from datetime import datetime, timedelta, timezone

_tmp_db = os.path.join(tempfile.mkdtemp(), "briefs.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import ProblemBrief, User  # noqa: E402


def _brief(db, owner_id, age_hours):
    row = ProblemBrief(
        user_id=owner_id,
        subject="maths",
        read_text="S_ABC = 24 cm²",
        created_at=datetime.now(timezone.utc) - timedelta(hours=age_hours),
    )
    db.add(row)
    db.commit()
    return row.id


def _ids(db):
    return {r.id for r in db.query(ProblemBrief).all()}


def _an_account(db, email):
    user = User(display_name="A", email=email, password_hash="x", is_email_verified=True)
    db.add(user)
    db.commit()
    return user.id


def test_an_old_guest_brief_is_thrown_away():
    """Nothing else in the app can reach it, so if this does not remove it,
    nothing ever will."""
    db = SessionLocal()
    old = _brief(db, None, server.GUEST_BRIEF_TTL_HOURS + 1)
    server._sweep_guest_briefs(db)
    assert old not in _ids(db)
    db.close()


def test_a_guest_brief_from_this_afternoon_stays():
    """The guest is still on that page. Their client could resend the photos
    after a 410, but making them do it for a page they are working on now would
    be a slower answer and another two images over the model."""
    db = SessionLocal()
    fresh = _brief(db, None, 1)
    server._sweep_guest_briefs(db)
    assert fresh in _ids(db)
    db.close()


def test_an_old_brief_with_an_owner_is_left_alone():
    """Summited shows these back, and the account's export must still contain
    them. Their removal belongs to the account, not to a sweep."""
    db = SessionLocal()
    uid = _an_account(db, "briefowner@example.com")
    owned = _brief(db, uid, server.GUEST_BRIEF_TTL_HOURS * 10)
    server._sweep_guest_briefs(db)
    assert owned in _ids(db)
    db.close()


def test_asking_a_question_sweeps(monkeypatch):
    """A sweep on a clock would never happen: Render sleeps a free service.
    It has to ride on the traffic that touches the table anyway."""
    db = SessionLocal()
    old = _brief(db, None, server.GUEST_BRIEF_TTL_HOURS + 1)
    db.close()

    swept = {}
    real = server._sweep_guest_briefs

    def spy(session):
        swept["yes"] = True
        return real(session)

    monkeypatch.setattr(server, "_sweep_guest_briefs", spy)
    monkeypatch.setattr(server.relay, "read_pages",
                        lambda *a, **k: ({"subject": "maths", "read_text": "x"}, object()))
    monkeypatch.setattr(server.usage, "record", lambda *a, **k: None)

    db = SessionLocal()

    class _Body:
        images = ["ignored"]
        question = "is it 12?"

    server._read_pages(db, _Body(), None, "en")
    assert swept.get("yes"), "_read_pages no longer sweeps"
    assert old not in _ids(db)
    db.close()


def test_the_filter_does_not_compare_a_boolean_or_a_null_with_an_operator():
    """`user_id == None` renders as `user_id = NULL`, which is NULL in Postgres
    and matches nothing — the sweep would silently do nothing in production
    while passing here. is_(None) renders IS NULL."""
    here = os.path.dirname(__file__)
    with open(os.path.join(here, "server.py"), encoding="utf-8") as f:
        src = f.read()
    fn = src[src.index("def _sweep_guest_briefs"):]
    fn = fn[:fn.index("\n\n\n")]
    assert "ProblemBrief.user_id.is_(None)" in fn
    assert "user_id == None" not in fn


def test_a_failed_sweep_does_not_cost_the_student_their_answer():
    """It is housekeeping. A question must not fail because of it."""
    db = SessionLocal()

    class _Exploding:
        def query(self, *a, **k):
            raise RuntimeError("no database today")

        def rollback(self):
            pass

    server._sweep_guest_briefs(_Exploding())   # must not raise
    db.close()
