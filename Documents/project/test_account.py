# test_account.py — change the password, take your data, leave.
#
# Run:  python -m pytest test_account.py -q
import os
import tempfile
from datetime import date

_tmp_db = os.path.join(tempfile.mkdtemp(), "account.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import (  # noqa: E402
    Classroom, ClassroomMember, FamilyLink, FocusSession, OAuthIdentity, PairedDevice,
    PhonePhoto, ScanHistory, Task, User,
)

client = TestClient(server.app)
PW = "testpass123"


def _login(email, role="student"):
    rate_limit._hits.clear()
    client.post("/auth/register", json={"display_name": email.split("@")[0], "email": email, "password": PW, "role": role})
    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    user.is_email_verified = True
    if role != "student":
        user.role = role
    db.commit()
    uid = user.id
    db.close()
    res = client.post("/auth/login", json={"email": email, "password": PW})
    assert res.status_code == 200, res.text
    return uid, {"Authorization": f"Bearer {res.json()['token']}"}


def _fill(uid):
    """Give an account one of everything the export and deletion must cover."""
    db = SessionLocal()
    db.add(Task(user_id=uid, text="Problems 4-8", subject="Math", deadline=date(2030, 1, 1)))
    db.add(ScanHistory(user_id=uid, question="What is 7x8?", answer="56"))
    db.add(FocusSession(user_id=uid, duration_seconds=900, focus_pct=80))
    dev = PairedDevice(user_id=uid, name="iPhone", token_hash="hash-" + uid)
    db.add(dev)
    db.flush()
    db.add(PhonePhoto(user_id=uid, device_id=dev.id, data="abc"))
    db.commit()
    db.close()


# --------------------------------------------------------------------------
# password
# --------------------------------------------------------------------------

def test_changing_the_password_needs_the_current_one():
    _, h = _login("pw1@example.com")
    res = client.post("/account/password", json={"current_password": "wrong-one", "new_password": "newpass123"}, headers=h)
    assert res.status_code == 400
    # the words are the same as a wrong sign-in: nothing to learn from them
    assert res.json()["detail"] == "Incorrect email or password."


def test_changing_the_password_ends_every_other_session():
    _, h_old = _login("pw2@example.com")
    res = client.post("/account/password", json={"current_password": PW, "new_password": "newpass123"}, headers=h_old)
    assert res.status_code == 200
    h_new = {"Authorization": f"Bearer {res.json()['token']}"}
    # the session that made the change continues; the one from before does not
    assert client.get("/auth/me", headers=h_new).status_code == 200
    assert client.get("/auth/me", headers=h_old).status_code == 401
    # and the new password is the one that works now
    rate_limit._hits.clear()
    assert client.post("/auth/login", json={"email": "pw2@example.com", "password": PW}).status_code in (400, 401)
    assert client.post("/auth/login", json={"email": "pw2@example.com", "password": "newpass123"}).status_code == 200


def test_a_google_only_account_can_set_its_first_password():
    uid, h = _login("goog@example.com")
    db = SessionLocal()
    u = db.query(User).get(uid)
    u.password_hash = None
    db.add(OAuthIdentity(user_id=uid, provider="google", subject="123"))
    db.commit()
    db.close()
    # no current password to give, and none is required
    res = client.post("/account/password", json={"new_password": "firstpass123"}, headers=h)
    assert res.status_code == 200


def test_a_short_new_password_is_refused():
    _, h = _login("pw3@example.com")
    assert client.post("/account/password", json={"current_password": PW, "new_password": "short"}, headers=h).status_code == 422


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------

def test_the_export_is_everything_the_policy_says_and_downloads_as_a_file():
    uid, h = _login("exp@example.com")
    _fill(uid)
    res = client.get("/account/export", headers=h)
    assert res.status_code == 200
    assert res.headers["content-disposition"].startswith('attachment; filename="climby-export-')
    data = res.json()
    assert data["account"]["email"] == "exp@example.com"
    assert data["tasks"][0]["text"] == "Problems 4-8" and data["tasks"][0]["deadline"] == "2030-01-01"
    assert data["questions"][0] == {**data["questions"][0], "question": "What is 7x8?", "answer": "56"}
    assert data["study_sessions"][0]["duration_seconds"] == 900
    assert data["linked_phones"][0]["name"] == "iPhone"
    # and nothing the policy says is not kept
    assert "data" not in str(data["linked_phones"]), "phone photo bytes must never be in an export"


def test_the_export_names_the_rope_team_but_nobody_elses_questions():
    student, hs = _login("kid@example.com")
    parent, hp = _login("mum@example.com", role="parent")
    db = SessionLocal()
    db.add(FamilyLink(parent_user_id=parent, student_user_id=student))
    db.add(ScanHistory(user_id=student, question="a private question", answer="…"))
    db.commit()
    db.close()
    mine = client.get("/account/export", headers=hs).json()
    theirs = client.get("/account/export", headers=hp).json()
    assert mine["rope_team"]["parents_with_access"][0]["name"] == "mum"
    assert theirs["rope_team"]["students_i_see"][0]["name"] == "kid"
    assert "a private question" not in str(theirs), "a parent's export must not carry the child's questions"


# --------------------------------------------------------------------------
# deletion
# --------------------------------------------------------------------------

def _count_everything(uid):
    db = SessionLocal()
    n = {
        "user": db.query(User).filter(User.id == uid).count(),
        "tasks": db.query(Task).filter(Task.user_id == uid).count(),
        "scans": db.query(ScanHistory).filter(ScanHistory.user_id == uid).count(),
        "sessions": db.query(FocusSession).filter(FocusSession.user_id == uid).count(),
        "devices": db.query(PairedDevice).filter(PairedDevice.user_id == uid).count(),
        "photos": db.query(PhonePhoto).filter(PhonePhoto.user_id == uid).count(),
        "links": db.query(FamilyLink).filter((FamilyLink.parent_user_id == uid) | (FamilyLink.student_user_id == uid)).count(),
        "memberships": db.query(ClassroomMember).filter(ClassroomMember.student_user_id == uid).count(),
        "classes": db.query(Classroom).filter(Classroom.teacher_user_id == uid).count(),
    }
    db.close()
    return n


def test_deletion_needs_the_password():
    uid, h = _login("del1@example.com")
    assert client.request("DELETE", "/account", json={"password": "nope"}, headers=h).status_code == 400
    assert _count_everything(uid)["user"] == 1


def test_deletion_removes_everything_and_the_session_with_it():
    uid, h = _login("del2@example.com")
    _fill(uid)
    before = _count_everything(uid)
    assert before["tasks"] == before["scans"] == before["sessions"] == before["devices"] == before["photos"] == 1
    res = client.request("DELETE", "/account", json={"password": PW}, headers=h)
    assert res.status_code == 200 and res.json() == {"status": "deleted"}
    assert all(v == 0 for v in _count_everything(uid).values()), _count_everything(uid)
    assert client.get("/auth/me", headers=h).status_code == 401
    # the address is free again
    rate_limit._hits.clear()
    assert client.post("/auth/register", json={"display_name": "Again", "email": "del2@example.com", "password": PW}).status_code == 200


def test_deleting_one_side_of_a_link_leaves_the_other_account_whole():
    student, hs = _login("s@example.com")
    parent, hp = _login("p@example.com", role="parent")
    _fill(parent)
    db = SessionLocal()
    db.add(FamilyLink(parent_user_id=parent, student_user_id=student))
    db.commit()
    db.close()
    assert client.request("DELETE", "/account", json={"password": PW}, headers=hs).status_code == 200
    after = _count_everything(parent)
    assert after["user"] == 1 and after["tasks"] == 1 and after["links"] == 0, after


def test_a_teachers_classes_go_with_the_teacher_but_the_students_stay():
    teacher, ht = _login("t@example.com", role="teacher")
    student, hs = _login("pupil@example.com")
    db = SessionLocal()
    room = Classroom(teacher_user_id=teacher, name="7b", join_code="ABC123")
    db.add(room)
    db.flush()
    db.add(ClassroomMember(classroom_id=room.id, student_user_id=student))
    db.commit()
    db.close()
    assert client.request("DELETE", "/account", json={"password": PW}, headers=ht).status_code == 200
    assert _count_everything(teacher)["classes"] == 0
    assert _count_everything(student)["memberships"] == 0
    assert client.get("/auth/me", headers=hs).status_code == 200, "the student's account is untouched"


def test_a_google_only_account_deletes_by_typing_the_word():
    uid, h = _login("gdel@example.com")
    db = SessionLocal()
    db.query(User).get(uid).password_hash = None
    db.commit()
    db.close()
    assert client.request("DELETE", "/account", json={"confirm": "delete me"}, headers=h).status_code == 400
    assert client.request("DELETE", "/account", json={"confirm": "DELETE"}, headers=h).status_code == 200
    assert _count_everything(uid)["user"] == 0


# --------------------------------------------------------------------------
# profile
# --------------------------------------------------------------------------

def test_the_first_sign_in_answers_are_saved_and_come_back_with_the_user():
    _, h = _login("prof@example.com")
    res = client.patch("/account/profile", json={"grade": 7, "city": "  Plovdiv  ", "heard_from": "teacher"}, headers=h)
    assert res.status_code == 200
    assert res.json()["grade"] == 7 and res.json()["city"] == "Plovdiv" and res.json()["heard_from"] == "teacher"
    me = client.get("/auth/me", headers=h).json()
    assert me["grade"] == 7 and me["city"] == "Plovdiv"


def test_a_grade_outside_school_is_refused():
    _, h = _login("prof2@example.com")
    assert client.patch("/account/profile", json={"grade": 0}, headers=h).status_code == 422
    assert client.patch("/account/profile", json={"grade": 13}, headers=h).status_code == 422


def test_a_field_left_out_is_left_alone():
    _, h = _login("prof3@example.com")
    client.patch("/account/profile", json={"grade": 4, "city": "Varna"}, headers=h)
    client.patch("/account/profile", json={"heard_from": "friend"}, headers=h)
    me = client.get("/auth/me", headers=h).json()
    assert me["grade"] == 4 and me["city"] == "Varna" and me["heard_from"] == "friend"
