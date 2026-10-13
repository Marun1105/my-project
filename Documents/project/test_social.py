# -*- coding: utf-8 -*-
# test_social.py — who can see what about whom.
#
# Everything here is one rule, taken from classes.py and not weakened:
# a peer sees numbers, never content. The tests that matter are therefore not
# "does the friends list work" but "what is in the response when it should not
# be" and "who still has access after being removed".
#
# Run:  python -m pytest test_social.py -q
import json
import os
import tempfile
import uuid

import pytest

_tmp_db = os.path.join(tempfile.mkdtemp(), "social.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi import HTTPException  # noqa: E402

import clibis  # noqa: E402
import server  # noqa: E402,F401
import social  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import Classroom, ClassroomMember, User  # noqa: E402


def _student(db, name="Мартин"):
    user = User(display_name=name, email=f"soc-{uuid.uuid4().hex[:12]}@example.com",
                password_hash="x", is_email_verified=True, grade=8)
    db.add(user)
    db.commit()
    return user


def _befriend(db, a, b):
    code = social.my_profile(user=b, db=db)["friend_code"]
    link = social.add_friend(code, user=a, db=db)
    social.accept_friend(link["id"], user=b, db=db)
    return link["id"]


# --------------------------------------------------------------- friend codes

def test_a_profile_gets_a_code_the_first_time_it_is_asked_for():
    """Accounts made before any of this existed must get one without a
    migration — so the row is created on first read, not at sign-up."""
    db = SessionLocal()
    user = _student(db)
    first = social.my_profile(user=user, db=db)["friend_code"]
    second = social.my_profile(user=user, db=db)["friend_code"]
    assert first and first == second
    assert set(first) <= set(social.CODE_ALPHABET)
    db.close()


def test_the_code_cannot_be_mistaken_when_read_out_loud():
    db = SessionLocal()
    user = _student(db)
    code = social.my_profile(user=user, db=db)["friend_code"]
    assert not (set("01OI") & set(code))
    db.close()


def test_you_cannot_befriend_yourself():
    db = SessionLocal()
    user = _student(db)
    code = social.my_profile(user=user, db=db)["friend_code"]
    with pytest.raises(HTTPException) as err:
        social.add_friend(code, user=user, db=db)
    assert err.value.status_code == 400
    db.close()


def test_an_unknown_code_is_not_found():
    db = SessionLocal()
    user = _student(db)
    with pytest.raises(HTTPException) as err:
        social.add_friend("ZZZZZZ", user=user, db=db)
    assert err.value.status_code == 404
    db.close()


def test_asking_twice_does_not_make_two_friendships():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    code = social.my_profile(user=b, db=db)["friend_code"]
    first = social.add_friend(code, user=a, db=db)
    second = social.add_friend(code, user=a, db=db)
    assert first["id"] == second["id"]
    db.close()


def test_the_other_side_asking_back_joins_the_same_friendship():
    """Two children who both tap each other's code should end up friends, not
    with two half-finished requests pointing in opposite directions."""
    db = SessionLocal()
    a, b = _student(db), _student(db)
    social.add_friend(social.my_profile(user=b, db=db)["friend_code"], user=a, db=db)
    back = social.add_friend(social.my_profile(user=a, db=db)["friend_code"], user=b, db=db)
    assert back["status"] == "accepted"
    db.close()


def test_a_request_is_pending_until_it_is_accepted():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    link = social.add_friend(social.my_profile(user=b, db=db)["friend_code"], user=a, db=db)
    assert link["status"] == "pending"
    assert social.list_friends(user=a, db=db)["friends"] == []
    social.accept_friend(link["id"], user=b, db=db)
    assert len(social.list_friends(user=a, db=db)["friends"]) == 1
    db.close()


def test_only_the_person_asked_can_accept():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    link = social.add_friend(social.my_profile(user=b, db=db)["friend_code"], user=a, db=db)
    with pytest.raises(HTTPException) as err:
        social.accept_friend(link["id"], user=a, db=db)
    assert err.value.status_code == 403
    db.close()


# ------------------------------------------------------------------- profiles

def test_a_friend_sees_the_numbers():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _befriend(db, a, b)
    clibis.award(db, b.id, "task_done", "t1")
    card = social.profile(b.id, user=a, db=db)
    assert card["clibis"] == clibis.RATES["task_done"]
    assert card["grade"] == 8
    db.close()


def test_a_stranger_sees_nothing():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    with pytest.raises(HTTPException) as err:
        social.profile(b.id, user=a, db=db)
    assert err.value.status_code == 403
    db.close()


def test_removing_a_friend_closes_the_door_at_once():
    """The access check must be asked fresh every time, not read from anything
    that was true when the page was opened."""
    db = SessionLocal()
    a, b = _student(db), _student(db)
    link = _befriend(db, a, b)
    assert social.profile(b.id, user=a, db=db)["clibis"] == 0
    social.remove_friend(link, user=a, db=db)
    with pytest.raises(HTTPException) as err:
        social.profile(b.id, user=a, db=db)
    assert err.value.status_code == 403
    db.close()


def test_a_classmate_counts_as_connected():
    """Base Camp already puts these children in a room together."""
    db = SessionLocal()
    a, b = _student(db), _student(db)
    room = Classroom(teacher_user_id=a.id, name="8в", join_code=f"C{uuid.uuid4().hex[:5].upper()}")
    db.add(room)
    db.commit()
    db.add_all([ClassroomMember(classroom_id=room.id, student_user_id=a.id),
                ClassroomMember(classroom_id=room.id, student_user_id=b.id)])
    db.commit()
    assert social.profile(b.id, user=a, db=db)["grade"] == 8
    db.close()


def test_a_profile_carries_no_text_a_student_wrote_or_was_told():
    """The rule from classes.py, asserted on the serialised response rather
    than on a model, because the leak that matters is the one that is sent."""
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _befriend(db, a, b)
    card = social.profile(b.id, user=a, db=db)
    # The exact set, not a search for bad words: a new field added later is
    # caught by this, and "tasks_done" is a count whose name contains "task".
    assert set(card) == {"name", "grade", "clibis", "solved", "tasks_done", "focus_minutes"}
    assert all(isinstance(card[k], (int, type(None))) for k in card if k != "name")
    db.close()


# ---------------------------------------------------------------- leaderboard

def test_the_board_between_friends_is_the_one_you_get_by_default():
    db = SessionLocal()
    a, b = _student(db), _student(db)
    _befriend(db, a, b)
    clibis.award(db, b.id, "task_done", "t1")
    rows = social.leaderboard(user=a, db=db)["rows"]
    names = [r["name"] for r in rows]
    assert a.display_name in names and b.display_name in names
    assert rows[0]["clibis"] >= rows[-1]["clibis"]
    db.close()


def test_the_global_board_never_carries_a_real_name():
    """A child does not stand in a public list under the name their teacher
    knows them by. Asserted on the JSON text: a shared response model is
    exactly how this would come back."""
    db = SessionLocal()
    a = _student(db, name="Мартин Христов")
    social.join_global_board(social.NicknameIn(nickname="Катерачът"), user=a, db=db)
    body = json.dumps(social.leaderboard(scope="global", user=a, db=db), ensure_ascii=False)
    assert "Мартин Христов" not in body
    assert "display_name" not in body
    assert "Катерачът" in body
    db.close()


def test_the_global_board_is_opt_in():
    db = SessionLocal()
    a = _student(db, name="Иван")
    body = json.dumps(social.leaderboard(scope="global", user=a, db=db), ensure_ascii=False)
    assert "Иван" not in body
    db.close()


def test_joining_the_global_board_needs_a_nickname():
    db = SessionLocal()
    a = _student(db)
    with pytest.raises(HTTPException) as err:
        social.join_global_board(social.NicknameIn(nickname="  "), user=a, db=db)
    assert err.value.status_code == 400
    db.close()
