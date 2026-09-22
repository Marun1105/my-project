# test_usage.py — the ceiling on what the AI can cost in a day.
#
# Run:  python -m pytest test_usage.py -q
import os
import tempfile

_tmp_db = os.path.join(tempfile.mkdtemp(), "usage.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
import usage  # noqa: E402
from db import SessionLocal  # noqa: E402

client = TestClient(server.app)


class _Usage:
    input_tokens = 700
    output_tokens = 300


class _Block:
    type = "text"
    text = "Answer."


class _Resp:
    content = [_Block()]
    usage = _Usage()


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    rate_limit._hits.clear()
    db = SessionLocal()
    db.query(usage.AiUsage).delete()
    db.commit()
    db.close()
    monkeypatch.setattr(server.client.messages, "create", lambda **kwargs: _Resp())
    monkeypatch.setattr(usage, "DAILY_TOKEN_CAP", 3_000_000)
    yield


def _ask():
    return client.post("/ask", json={"images": [], "question": "What is 7x8?", "lang": "en"})


def test_every_answer_is_counted_in_tokens_not_calls():
    assert _ask().status_code == 200
    assert _ask().status_code == 200
    db = SessionLocal()
    today = usage.today(db)
    db.close()
    assert today["calls"] == 2
    assert today["tokens"] == 2000, "input and output tokens, both"


def test_the_cap_refuses_kindly_and_spends_nothing_more(monkeypatch):
    monkeypatch.setattr(usage, "DAILY_TOKEN_CAP", 1500)
    assert _ask().status_code == 200          # 1000 used, under the cap
    assert _ask().status_code == 200          # 2000 used — this call was allowed because we check before
    res = _ask()                              # now over: refused
    assert res.status_code == 503
    assert "taking a rest" in res.json()["detail"]
    db = SessionLocal()
    assert usage.today(db)["calls"] == 2, "the refused call spent nothing"
    db.close()


def test_the_refusal_speaks_the_students_language(monkeypatch):
    monkeypatch.setattr(usage, "DAILY_TOKEN_CAP", 1)
    _ask()
    res = client.post("/ask", json={"images": [], "question": "Колко е 7 по 8?", "lang": "bg"})
    assert res.status_code == 503
    assert "почива" in res.json()["detail"]


def test_the_planner_shares_the_same_budget(monkeypatch):
    monkeypatch.setattr(usage, "DAILY_TOKEN_CAP", 1)
    _ask()  # spends the day
    res = client.post("/plan", json={"tasks": [{"text": "Read chapter 3"}], "lang": "en"})
    assert res.status_code == 503


def test_a_cap_of_zero_means_no_cap(monkeypatch):
    monkeypatch.setattr(usage, "DAILY_TOKEN_CAP", 0)
    for _ in range(3):
        assert _ask().status_code == 200


def test_healthz_shows_the_days_spend():
    _ask()
    body = client.get("/healthz").json()
    assert body["ai_today"]["calls"] == 1 and body["ai_today"]["tokens"] == 1000
    assert body["ai_today"]["cap"] == 3_000_000
