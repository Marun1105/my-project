# -*- coding: utf-8 -*-
# test_rope_anchor.py — свръзката и клинът.
#
# Two features that both touch the currency, and both have a failure mode that
# costs a child something real: a bonus paid twice makes the board a lie, and
# an anchor charged for a day it does not cover takes 60 clibis for nothing.
#
# Run:  python -m pytest test_rope_anchor.py -q
import os
import tempfile
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

_tmp_db = os.path.join(tempfile.mkdtemp(), "rope.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi import HTTPException  # noqa: E402

import clibis  # noqa: E402
import server  # noqa: E402,F401
import social  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import ClibiLedger, RopePartner, StreakAnchor, User  # noqa: E402


def _student(db):
    user = User(display_name="К", email=f"rope-{uuid.uuid4().hex[:12]}@example.com",
                password_hash="x", is_email_verified=True)
    db.add(user)
    db.commit()
    return user


def _friends(db, a, b):
    link = social.add_friend(social.my_profile(user=b, db=db)["friend_code"], user=a, db=db)
    social.accept_friend(link["id"], user=b, db=db)
    return link["id"]


def _earn(db, user_id, amount, when=None):
    """Clibis already earned, placed on a chosen day."""
    row = ClibiLedger(user_id=user_id, amount=amount, reason="task_done",
                      ref_id=f"seed-{uuid.uuid4().hex[:8]}",
                      created_at=when or datetime.now(timezone.utc))
    db.add(row)
    db.commit()


def _last_week_pair(db, a, b, target, a_earned, b_earned):
    start = social._week_start() - timedelta(days=7)
    when = datetime.combine(start + timedelta(days=2), datetime.min.time(), tzinfo=timezone.utc)
    pair = RopePartner(a_user_id=a.id, b_user_id=b.id, week_start=start, target=target)
    db.add(pair)
    db.commit()
    _earn(db, a.id, a_earned, when)
    _earn(db, b.id, b_earned, when)
    return pair


# ------------------------------------------------------------------- свръзката

def test_a_rope_can_only_be_tied_to_a_friend():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    with pytest.raises(HTTPException) as err:
        social.tie_rope(b.id, social.RopeIn(target=100), user=a, db=db)
    assert err.value.status_code == 403
    db.close()


def test_tying_a_rope_shows_both_climbers_progress():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _friends(db, a, b)
    social.tie_rope(b.id, social.RopeIn(target=100), user=a, db=db)
    _earn(db, a.id, 40)
    rope = social.my_rope(user=a, db=db)
    assert rope["target"] == 100
    assert rope["mine"] == 40
    assert rope["theirs"] == 0
    db.close()


def test_one_rope_a_week():
    db = SessionLocal()
    a, b, c = _student(db), _student(db), _student(db)
    _friends(db, a, b)
    _friends(db, a, c)
    social.tie_rope(b.id, social.RopeIn(target=100), user=a, db=db)
    with pytest.raises(HTTPException) as err:
        social.tie_rope(c.id, social.RopeIn(target=100), user=a, db=db)
    assert err.value.status_code == 400
    db.close()


def test_both_reaching_the_target_pays_both():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _friends(db, a, b)
    _last_week_pair(db, a, b, target=50, a_earned=60, b_earned=55)
    before_a, before_b = clibis.balance(db, a.id), clibis.balance(db, b.id)
    social.my_rope(user=a, db=db)
    assert clibis.balance(db, a.id) == before_a + clibis.RATES["rope_bonus"]
    assert clibis.balance(db, b.id) == before_b + clibis.RATES["rope_bonus"]
    db.close()


def test_the_bonus_is_paid_once_however_often_the_screen_is_opened():
    """It settles when read, because Render sleeps a free service and a clock
    would never run. Read twice is therefore the ordinary case, not the odd one."""
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _friends(db, a, b)
    _last_week_pair(db, a, b, target=50, a_earned=60, b_earned=55)
    social.my_rope(user=a, db=db)
    paid = clibis.balance(db, a.id)
    social.my_rope(user=a, db=db)
    social.my_rope(user=b, db=db)
    assert clibis.balance(db, a.id) == paid
    db.close()


def test_if_one_of_them_misses_neither_is_paid():
    """The only way to win is for the other one to manage it too. That is the
    whole point of the feature, so it is the test that guards it."""
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _friends(db, a, b)
    _last_week_pair(db, a, b, target=50, a_earned=90, b_earned=10)
    before = clibis.balance(db, a.id)
    social.my_rope(user=a, db=db)
    assert clibis.balance(db, a.id) == before
    db.close()


def test_a_week_still_running_is_not_settled_early():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _friends(db, a, b)
    social.tie_rope(b.id, social.RopeIn(target=10), user=a, db=db)
    _earn(db, a.id, 50)
    _earn(db, b.id, 50)
    before = clibis.balance(db, a.id)
    social.my_rope(user=a, db=db)
    assert clibis.balance(db, a.id) == before
    db.close()


# ----------------------------------------------------------------------- клин

def test_an_anchor_costs_clibis_and_holds_the_day():
    db = SessionLocal()
    user = _student(db)
    _earn(db, user.id, 200)
    before = clibis.balance(db, user.id)
    day = date(2026, 10, 12)
    clibis.buy_anchor(clibis.AnchorIn(day=day), user=user, db=db)
    assert clibis.balance(db, user.id) == before - clibis.ANCHOR_COST
    assert db.query(StreakAnchor).filter(StreakAnchor.user_id == user.id,
                                         StreakAnchor.day == day).count() == 1
    db.close()


def test_an_anchor_you_cannot_afford_is_refused_before_it_charges():
    db = SessionLocal()
    user = _student(db)
    _earn(db, user.id, clibis.ANCHOR_COST - 1)
    with pytest.raises(HTTPException) as err:
        clibis.buy_anchor(clibis.AnchorIn(day=date(2026, 10, 12)), user=user, db=db)
    assert err.value.status_code == 400
    assert clibis.balance(db, user.id) == clibis.ANCHOR_COST - 1
    db.close()


def test_buying_a_day_that_is_already_anchored_takes_nothing():
    """The Review Focus case: a double tap must not cost 60 clibis for a day
    that was already held."""
    db = SessionLocal()
    user = _student(db)
    _earn(db, user.id, 500)
    day = date(2026, 10, 12)
    clibis.buy_anchor(clibis.AnchorIn(day=day), user=user, db=db)
    after_first = clibis.balance(db, user.id)
    with pytest.raises(HTTPException) as err:
        clibis.buy_anchor(clibis.AnchorIn(day=day), user=user, db=db)
    assert err.value.status_code == 409
    assert clibis.balance(db, user.id) == after_first
    db.close()


def test_one_anchor_a_month():
    """A streak you can buy every day is not a streak."""
    db = SessionLocal()
    user = _student(db)
    _earn(db, user.id, 500)
    clibis.buy_anchor(clibis.AnchorIn(day=date(2026, 10, 12)), user=user, db=db)
    with pytest.raises(HTTPException) as err:
        clibis.buy_anchor(clibis.AnchorIn(day=date(2026, 10, 20)), user=user, db=db)
    assert err.value.status_code == 400
    db.close()


def test_the_browser_is_told_which_days_are_anchored():
    """The streak is counted in the browser, in the child's own time zone —
    activity.py says so. So the anchor has to reach the same calculation."""
    import activity
    db = SessionLocal()
    user = _student(db)
    _earn(db, user.id, 500)
    day = date(2026, 10, 12)
    clibis.buy_anchor(clibis.AnchorIn(day=day), user=user, db=db)
    out = activity.activity(today=None, user=user, db=db)
    assert day in out.anchored
    db.close()
