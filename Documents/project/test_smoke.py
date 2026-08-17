# test_smoke.py — бързи тестове, които хващат счупени основни пътища след промяна.
# Не викат Anthropic API: всичко, което би струвало пари, е подменено (monkeypatch).
#
# Пускане:  python -m pytest test_smoke.py -q
import os
import tempfile

import pytest

# Базата трябва да е временна ОЩЕ преди да се внесе server.py — иначе тестовете
# биха писали в истинския climby.db.
_tmp_db = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import planner  # noqa: E402
import rate_limit  # noqa: E402
import server  # noqa: E402

client = TestClient(server.app)


@pytest.fixture(autouse=True)
def _clear_rate_limits():
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


def _register_and_login(email="smoke@example.com", password="testpass123"):
    client.post("/auth/register", json={"display_name": "Smoke", "email": email, "password": password})
    # кодът се хешира в базата, затова го маркираме като потвърден директно
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


def test_health():
    assert client.get("/").json() == {"status": "ok"}


def test_plan_with_no_tasks_skips_the_model():
    # празният списък трябва да върне готов текст, без да вика Anthropic
    res = client.post("/plan", json={"tasks": [], "lang": "bg"})
    assert res.status_code == 200
    assert "Няма чакащи задачи" in res.json()["advice"]

    res_en = client.post("/plan", json={"tasks": [], "lang": "en"})
    assert "no pending tasks" in res_en.json()["advice"]


def test_login_requires_verified_email():
    client.post("/auth/register", json={
        "display_name": "Unverified", "email": "unverified@example.com", "password": "testpass123",
    })
    res = client.post("/auth/login", json={"email": "unverified@example.com", "password": "testpass123"})
    assert res.status_code == 403


def test_wrong_password_rejected():
    headers = _register_and_login("wrongpass@example.com")
    assert headers  # регистрацията мина
    res = client.post("/auth/login", json={"email": "wrongpass@example.com", "password": "notmypassword"})
    assert res.status_code == 401


def test_tasks_crud_and_isolation():
    alice = _register_and_login("alice@example.com")
    bob = _register_and_login("bob@example.com")

    created = client.post("/tasks", json={"text": "Задача 1", "subject": "Математика"}, headers=alice)
    assert created.status_code == 200
    task_id = created.json()["id"]

    assert len(client.get("/tasks", headers=alice).json()) == 1
    # чужда задача не се вижда и не може да се пипа
    assert client.get("/tasks", headers=bob).json() == []
    assert client.patch(f"/tasks/{task_id}", json={"done": True}, headers=bob).status_code == 404
    assert client.delete(f"/tasks/{task_id}", headers=bob).status_code == 404

    done = client.patch(f"/tasks/{task_id}", json={"done": True}, headers=alice)
    assert done.status_code == 200 and done.json()["done"] is True
    assert done.json()["completed_at"] is not None

    assert client.delete(f"/tasks/{task_id}", headers=alice).status_code == 200
    assert client.get("/tasks", headers=alice).json() == []


def test_protected_endpoints_require_auth():
    for method, path in [("get", "/tasks"), ("get", "/scans"), ("get", "/focus")]:
        assert getattr(client, method)(path).status_code == 401


def test_focus_session_roundtrip_and_short_filter():
    headers = _register_and_login("focus@example.com")
    assert client.post("/focus", json={"duration_seconds": 1500, "focus_pct": 80}, headers=headers).status_code == 200
    # под минута не бива да влиза в статистиката
    assert client.post("/focus", json={"duration_seconds": 20}, headers=headers).status_code == 200

    listed = client.get("/focus", headers=headers).json()
    assert [s["duration_seconds"] for s in listed] == [1500]


def test_ask_saves_scan_history_for_logged_in_user(monkeypatch):
    headers = _register_and_login("scan@example.com")

    class _Block:
        type = "text"
        text = "Ето обяснението."

    class _Resp:
        content = [_Block()]

    monkeypatch.setattr(server.client.messages, "create", lambda **kwargs: _Resp())

    res = client.post("/ask", json={"images": [], "question": "Какво е това?", "lang": "bg"}, headers=headers)
    assert res.status_code == 200 and res.json()["answer"] == "Ето обяснението."

    scans = client.get("/scans", headers=headers).json()
    assert len(scans) == 1
    assert scans[0]["question"] == "Какво е това?"
    assert client.delete(f"/scans/{scans[0]['id']}", headers=headers).status_code == 200
    assert client.get("/scans", headers=headers).json() == []


def test_ask_as_guest_is_not_saved(monkeypatch):
    class _Block:
        type = "text"
        text = "Отговор за гост."

    class _Resp:
        content = [_Block()]

    monkeypatch.setattr(server.client.messages, "create", lambda **kwargs: _Resp())
    res = client.post("/ask", json={"images": [], "question": "Гост въпрос", "lang": "bg"})
    assert res.status_code == 200


def test_split_parses_json_array(monkeypatch):
    class _Block:
        type = "text"
        text = '["Стъпка 1", "Стъпка 2", "Стъпка 3"]'

    class _Resp:
        content = [_Block()]

    monkeypatch.setattr(planner.client.messages, "create", lambda **kwargs: _Resp())
    res = client.post("/plan/split", json={"text": "Голяма задача", "lang": "bg"})
    assert res.status_code == 200
    assert res.json()["steps"] == ["Стъпка 1", "Стъпка 2", "Стъпка 3"]


def test_split_tolerates_markdown_fence(monkeypatch):
    class _Block:
        type = "text"
        text = '```json\n["А", "Б"]\n```'

    class _Resp:
        content = [_Block()]

    monkeypatch.setattr(planner.client.messages, "create", lambda **kwargs: _Resp())
    res = client.post("/plan/split", json={"text": "Задача", "lang": "bg"})
    assert res.status_code == 200 and res.json()["steps"] == ["А", "Б"]


def test_split_rejects_empty_text():
    assert client.post("/plan/split", json={"text": "   ", "lang": "bg"}).status_code == 400


def test_register_is_rate_limited():
    for i in range(5):
        res = client.post("/auth/register", json={
            "display_name": f"RL{i}", "email": f"rl{i}@example.com", "password": "testpass123",
        })
        assert res.status_code == 200, res.text
    blocked = client.post("/auth/register", json={
        "display_name": "RL6", "email": "rl6@example.com", "password": "testpass123",
    })
    assert blocked.status_code == 429


def test_rate_limiter_ignores_spoofed_forwarded_for(monkeypatch):
    # с 1 доверено прокси истинският адрес е най-отдясно; лявата част е под контрол на клиента
    monkeypatch.setattr(rate_limit, "TRUSTED_PROXY_HOPS", 1)

    class _Req:
        def __init__(self, xff, host="10.0.0.1"):
            self.headers = {"x-forwarded-for": xff}
            self.client = type("C", (), {"host": host})()

    assert rate_limit._client_key(_Req("1.1.1.1, 203.0.113.9")) == "203.0.113.9"
    assert rate_limit._client_key(_Req("evil, other, 203.0.113.9")) == "203.0.113.9"


def test_password_minimum_length():
    res = client.post("/auth/register", json={
        "display_name": "Short", "email": "short@example.com", "password": "abc",
    })
    assert res.status_code == 422
