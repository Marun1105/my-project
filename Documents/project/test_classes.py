# test_classes.py — учителски класове: роли, присъединяване с код и границите
# на това, което учителят вижда.
#
# Пускане:  python -m pytest test_classes.py -q
import os
import tempfile

import pytest

_tmp_db = os.path.join(tempfile.mkdtemp(), "test_classes.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret-for-classes"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402

client = TestClient(server.app)


@pytest.fixture(autouse=True)
def _clear_rate_limits():
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


def _account(email, role="student", password="testpass123"):
    res = client.post("/auth/register", json={
        "display_name": email.split("@")[0], "email": email, "password": password, "role": role,
    })
    assert res.status_code == 200, res.text

    from db import SessionLocal
    from models import User

    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    user.is_email_verified = True
    db.commit()
    db.close()

    res = client.post("/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def test_role_defaults_to_student_when_not_sent():
    # стар клиент, който още не знае за ролите, трябва да продължи да работи
    res = client.post("/auth/register", json={
        "display_name": "Old", "email": "oldclient@example.com", "password": "testpass123",
    })
    assert res.status_code == 200, res.text

    from db import SessionLocal
    from models import User

    db = SessionLocal()
    user = db.query(User).filter(User.email == "oldclient@example.com").first()
    assert user.role == "student"
    db.close()


def test_role_is_returned_on_login():
    headers = _account("teacher-role@example.com", role="teacher")
    assert headers  # регистрацията и входът минаха
    res = client.post("/auth/login", json={"email": "teacher-role@example.com", "password": "testpass123"})
    assert res.json()["user"]["role"] == "teacher"


def test_invalid_role_is_rejected():
    res = client.post("/auth/register", json={
        "display_name": "Sneaky", "email": "sneaky@example.com",
        "password": "testpass123", "role": "admin",
    })
    assert res.status_code == 422


def test_only_a_teacher_can_create_a_class():
    student = _account("not-a-teacher@example.com", role="student")
    res = client.post("/classes", json={"name": "7А"}, headers=student)
    assert res.status_code == 403


def test_class_create_join_and_progress():
    teacher = _account("teacher1@example.com", role="teacher")
    student = _account("student1@example.com", role="student")

    created = client.post("/classes", json={"name": "7А"}, headers=teacher)
    assert created.status_code == 200, created.text
    code = created.json()["join_code"]
    assert created.json()["student_count"] == 0

    joined = client.post("/classes/join", json={"code": code.lower()}, headers=student)
    assert joined.status_code == 200, joined.text
    assert joined.json()["class_name"] == "7А"

    # ученикът добавя задача и я отмята — учителят трябва да види числата
    client.post("/tasks", json={"text": "Задача 5", "subject": "Математика"}, headers=student)
    listed = client.get("/classes", headers=teacher).json()
    assert len(listed) == 1
    assert listed[0]["student_count"] == 1
    assert listed[0]["students"][0]["tasks_pending"] == 1


def test_teacher_sees_only_numbers_never_task_text():
    teacher = _account("teacher2@example.com", role="teacher")
    student = _account("student2@example.com", role="student")
    code = client.post("/classes", json={"name": "8Б"}, headers=teacher).json()["join_code"]
    client.post("/classes/join", json={"code": code}, headers=student)
    client.post("/tasks", json={"text": "МНОГО ЛИЧЕН ТЕКСТ", "subject": "Химия"}, headers=student)

    body = client.get("/classes", headers=teacher).text
    assert "МНОГО ЛИЧЕН ТЕКСТ" not in body
    assert "Химия" not in body


def test_cannot_join_twice_or_join_own_class():
    teacher = _account("teacher3@example.com", role="teacher")
    student = _account("student3@example.com", role="student")
    code = client.post("/classes", json={"name": "9В"}, headers=teacher).json()["join_code"]

    assert client.post("/classes/join", json={"code": code}, headers=student).status_code == 200
    assert client.post("/classes/join", json={"code": code}, headers=student).status_code == 400
    # учителят не може да влезе в собствения си клас
    assert client.post("/classes/join", json={"code": code}, headers=teacher).status_code == 400


def test_bad_code_is_rejected():
    student = _account("student4@example.com", role="student")
    assert client.post("/classes/join", json={"code": "ZZZZZZ"}, headers=student).status_code == 400


def test_student_can_see_and_leave_their_classes():
    teacher = _account("teacher5@example.com", role="teacher")
    student = _account("student5@example.com", role="student")
    code = client.post("/classes", json={"name": "10Г"}, headers=teacher).json()["join_code"]
    client.post("/classes/join", json={"code": code}, headers=student)

    mine = client.get("/classes/mine", headers=student).json()
    assert len(mine) == 1
    assert mine[0]["name"] == "10Г"
    assert mine[0]["teacher_name"] == "teacher5"

    class_id = mine[0]["class_id"]
    assert client.delete(f"/classes/mine/{class_id}", headers=student).status_code == 200
    assert client.get("/classes/mine", headers=student).json() == []


def test_teacher_cannot_touch_another_teachers_class():
    teacher_a = _account("teacher6a@example.com", role="teacher")
    teacher_b = _account("teacher6b@example.com", role="teacher")
    student = _account("student6@example.com", role="student")

    created = client.post("/classes", json={"name": "11А"}, headers=teacher_a).json()
    client.post("/classes/join", json={"code": created["join_code"]}, headers=student)

    # чужд учител не вижда класа и не може да го трие или да маха ученици от него
    assert client.get("/classes", headers=teacher_b).json() == []
    assert client.delete(f"/classes/{created['id']}", headers=teacher_b).status_code == 404
    assert client.delete(
        f"/classes/{created['id']}/students/{student}", headers=teacher_b
    ).status_code == 404


def test_deleting_a_class_removes_its_members():
    teacher = _account("teacher7@example.com", role="teacher")
    student = _account("student7@example.com", role="student")
    created = client.post("/classes", json={"name": "12Б"}, headers=teacher).json()
    client.post("/classes/join", json={"code": created["join_code"]}, headers=student)

    assert client.delete(f"/classes/{created['id']}", headers=teacher).status_code == 200
    assert client.get("/classes/mine", headers=student).json() == []

    from db import SessionLocal
    from models import ClassroomMember

    db = SessionLocal()
    assert db.query(ClassroomMember).filter(ClassroomMember.classroom_id == created["id"]).count() == 0
    db.close()
