# -*- coding: utf-8 -*-
# test_clibis.py — the currency.
#
# Clibis are the only number in Climby a student can watch go up, so the two
# ways they could go wrong both matter more than the happy path: paying twice
# for one piece of work makes the board meaningless, and paying the wrong
# person makes it worse than meaningless. Both are tested here.
#
# Run:  python -m pytest test_clibis.py -q
import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone

# Set, not setdefault, and for the same reason test_guest_briefs.py says so:
# this file writes, and a DATABASE_URL left in the shell must never decide
# where. Under the whole suite an earlier module may already have bound the
# engine, so every assertion below is scoped to the account it just made.
_tmp_db = os.path.join(tempfile.mkdtemp(), "clibis.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import pytest  # noqa: E402

import server  # noqa: E402,F401  — importing it is what creates the schema
import clibis  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import ClibiLedger, User  # noqa: E402


def _account(db):
    user = User(display_name="A", email=f"clibi-{uuid.uuid4().hex[:12]}@example.com",
                password_hash="x", is_email_verified=True)
    db.add(user)
    db.commit()
    return user.id


def test_the_same_piece_of_work_is_paid_for_once():
    """The student taps "done", the connection drops, the phone retries. One
    task, one payment — enforced by the database, not by looking first."""
    db = SessionLocal()
    uid = _account(db)
    first = clibis.award(db, uid, "task_done", "task-1")
    second = clibis.award(db, uid, "task_done", "task-1")
    assert first == clibis.RATES["task_done"]
    assert second == 0
    assert clibis.balance(db, uid) == clibis.RATES["task_done"]
    db.close()


def test_different_work_is_paid_for_separately():
    db = SessionLocal()
    uid = _account(db)
    clibis.award(db, uid, "task_done", "task-1")
    clibis.award(db, uid, "task_done", "task-2")
    assert clibis.balance(db, uid) == 2 * clibis.RATES["task_done"]
    db.close()


def test_a_reason_that_is_not_a_rate_is_refused():
    """A typo in a call site must not quietly pay nothing, or quietly pay
    something. It must stop the developer who wrote it."""
    db = SessionLocal()
    uid = _account(db)
    with pytest.raises(KeyError):
        clibis.award(db, uid, "beacuse_i_said_so", "x")
    db.close()


def test_the_daily_cap_holds():
    """A student who finds a loop cannot run away with the board. The cap is
    high enough that an honest heavy day never reaches it."""
    db = SessionLocal()
    uid = _account(db)
    paid = 0
    for n in range(40):
        paid += clibis.award(db, uid, "task_done", f"cap-{n}")
    assert paid == clibis.DAILY_CAP
    assert clibis.balance(db, uid) == clibis.DAILY_CAP
    db.close()


def test_yesterdays_earnings_do_not_eat_todays_cap():
    """The cap is a day's allowance, not a lifetime one."""
    db = SessionLocal()
    uid = _account(db)
    old = ClibiLedger(user_id=uid, amount=clibis.DAILY_CAP, reason="task_done", ref_id="yesterday",
                      created_at=datetime.now(timezone.utc) - timedelta(days=1))
    db.add(old)
    db.commit()
    assert clibis.award(db, uid, "task_done", "today") == clibis.RATES["task_done"]
    db.close()


def test_one_students_clibis_are_not_anothers():
    db = SessionLocal()
    a, b = _account(db), _account(db)
    clibis.award(db, a, "task_done", "task-1")
    assert clibis.balance(db, b) == 0
    db.close()


def test_solving_it_yourself_pays_more_than_finishing_a_task():
    """The only rate comparison that is a product decision rather than a
    number: if asking ClimbAI for the answer were the fast way to get rich,
    the currency would teach the opposite of what the app is for."""
    assert clibis.RATES["solved_step"] > clibis.RATES["task_done"]
    assert "question" not in clibis.RATES and "asked" not in clibis.RATES


def test_spending_is_a_negative_row_not_a_deletion():
    """The ledger answers "why do I have 240?". A spend that erased rows would
    make it lie, and a balance that drifts from its own history is the bug the
    ledger exists to prevent."""
    db = SessionLocal()
    uid = _account(db)
    clibis.award(db, uid, "task_done", "task-1")
    before = clibis.balance(db, uid)
    clibis.spend(db, uid, 4, "anchor", "2026-10-13")
    assert clibis.balance(db, uid) == before - 4
    assert db.query(ClibiLedger).filter(ClibiLedger.user_id == uid).count() == 2
    db.close()


def test_you_cannot_spend_what_you_do_not_have():
    db = SessionLocal()
    uid = _account(db)
    assert clibis.spend(db, uid, 60, "anchor", "2026-10-13") is False
    assert clibis.balance(db, uid) == 0
    db.close()
