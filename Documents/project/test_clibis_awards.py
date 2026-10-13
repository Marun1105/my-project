# -*- coding: utf-8 -*-
# test_clibis_awards.py — where clibis come from.
#
# clibis.py is tested on its own in test_clibis.py. This file is about the
# three seams: a task turning done, a focus session being saved, and an answer
# the tutor marked as solved unaided. Each one is a fact about work, which is
# why the award hangs off it rather than off an endpoint a client could call.
#
# Run:  python -m pytest test_clibis_awards.py -q
import os
import tempfile
import uuid
from datetime import datetime, timezone

_tmp_db = os.path.join(tempfile.mkdtemp(), "awards.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import clibis  # noqa: E402
import focus_sessions  # noqa: E402
import server  # noqa: E402,F401
import tasks as tasks_api  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import Task, User  # noqa: E402
from schemas import FocusSessionIn, TaskUpdate  # noqa: E402


class _Request:
    """rate_limit.enforce wants a Request; it only reads the client address."""
    client = type("c", (), {"host": "127.0.0.1"})()
    headers = {}


def _student(db):
    user = User(display_name="A", email=f"award-{uuid.uuid4().hex[:12]}@example.com",
                password_hash="x", is_email_verified=True)
    db.add(user)
    db.commit()
    return user


def _task(db, user, done=False):
    row = Task(user_id=user.id, text="Задачи 4–8", done=done)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_finishing_a_task_pays():
    db = SessionLocal()
    user = _student(db)
    task = _task(db, user)
    before = clibis.balance(db, user.id)
    tasks_api.update_task(task.id, TaskUpdate(done=True), user=user, db=db)
    assert clibis.balance(db, user.id) == before + clibis.RATES["task_done"] + clibis.RATES["streak_day"]
    db.close()


def test_unticking_and_reticking_the_same_task_does_not_pay_again():
    """The checklist has a checkbox, and a checkbox gets played with. One task
    is one piece of work however many times it is toggled."""
    db = SessionLocal()
    user = _student(db)
    task = _task(db, user)
    tasks_api.update_task(task.id, TaskUpdate(done=True), user=user, db=db)
    after_first = clibis.balance(db, user.id)
    tasks_api.update_task(task.id, TaskUpdate(done=False), user=user, db=db)
    tasks_api.update_task(task.id, TaskUpdate(done=True), user=user, db=db)
    assert clibis.balance(db, user.id) == after_first
    db.close()


def test_unticking_a_task_does_not_take_clibis_back():
    """Taking them back would make the number flicker for a mis-tap, and the
    work was still done. The ledger only grows for work."""
    db = SessionLocal()
    user = _student(db)
    task = _task(db, user)
    tasks_api.update_task(task.id, TaskUpdate(done=True), user=user, db=db)
    paid = clibis.balance(db, user.id)
    tasks_api.update_task(task.id, TaskUpdate(done=False), user=user, db=db)
    assert clibis.balance(db, user.id) == paid
    db.close()


def test_editing_a_tasks_text_pays_nothing():
    db = SessionLocal()
    user = _student(db)
    task = _task(db, user)
    tasks_api.update_task(task.id, TaskUpdate(text="друго"), user=user, db=db)
    assert clibis.balance(db, user.id) == 0
    db.close()


def test_a_real_focus_session_pays_and_a_stray_tap_does_not():
    db = SessionLocal()
    user = _student(db)
    focus_sessions.create_session(
        FocusSessionIn(duration_seconds=focus_sessions.MIN_SESSION_SECONDS + 1, focus_pct=80),
        _Request(), user=user, db=db)
    earned = clibis.balance(db, user.id)
    assert earned >= clibis.RATES["focus_session"]

    focus_sessions.create_session(
        FocusSessionIn(duration_seconds=5, focus_pct=80), _Request(), user=user, db=db)
    assert clibis.balance(db, user.id) == earned
    db.close()


def test_turning_up_is_paid_once_a_day():
    """Two tasks on one afternoon is one day of turning up, not two."""
    db = SessionLocal()
    user = _student(db)
    one, two = _task(db, user), _task(db, user)
    tasks_api.update_task(one.id, TaskUpdate(done=True), user=user, db=db)
    tasks_api.update_task(two.id, TaskUpdate(done=True), user=user, db=db)
    expected = 2 * clibis.RATES["task_done"] + clibis.RATES["streak_day"]
    assert clibis.balance(db, user.id) == expected
    db.close()


def test_solving_it_yourself_is_what_server_pays_for():
    """The tutor decides this, not the student: ScanHistory.solved_unaided is
    set from the model's own mark. So the award hangs off that flag and off
    nothing the client sends."""
    import inspect
    src = inspect.getsource(server)
    at = src.index("solved_unaided=solved")
    window = src[at:at + 900]
    assert "solved_step" in window, "the answer that was solved unaided is not paid for"
    # And the question itself must not be: no rate exists, so a call would raise.
    assert "question" not in clibis.RATES
