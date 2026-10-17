# -*- coding: utf-8 -*-
# test_smart_actions.py — what ClimbAI can offer besides an answer: a quiz, a
# study plan, a Study timer suggestion, and the weekly summary's numbers.
#
# Run:  python -m pytest test_smart_actions.py -q
from datetime import datetime, timedelta, timezone

from test_task_offer import _answers, _login, client, FENCE  # noqa: F401
from db import SessionLocal
from models import FocusSession, Task


def _ask(headers=None, surface="chat", memory=None, lang="en"):
    body = {"images": [], "question": "quiz me on fractions", "lang": lang,
            "context": False, "surface": surface, "memory": memory}
    return client.post("/ask", json=body, headers=headers or {})


QUIZ = f'Ready.\n{FENCE}climby-quiz\n{{"title": "Fractions", "cards": [{{"q": "1/2+1/4", "a": "3/4"}}]}}\n{FENCE}'
PLAN = f'Plan.\n{FENCE}climby-plan\n[{{"text": "Revise cells", "deadline": "2030-05-20"}}]\n{FENCE}'
TIMER = f'Go.\n{FENCE}climby-timer\n{{"minutes": 25, "label": "Maths"}}\n{FENCE}'


def test_quiz_plan_and_timer_come_back_as_cards_not_text(monkeypatch):
    _uid, h = _login("smart1@example.com")
    _answers(monkeypatch, QUIZ + "\n" + PLAN + "\n" + TIMER)
    data = _ask(h).json()
    assert FENCE not in data["answer"] and "climby-" not in data["answer"]
    assert data["quiz"]["cards"] == [{"q": "1/2+1/4", "a": "3/4", "why": ""}]
    assert data["plan"][0]["text"] == "Revise cells"
    assert data["timer"] == {"minutes": 25, "label": "Maths"}


def test_the_abilities_are_offered_in_the_chat_to_a_signed_in_student(monkeypatch):
    _uid, h = _login("smart2@example.com")
    seen = _answers(monkeypatch, "Fine.")
    assert _ask(h).status_code == 200
    assert "climby-quiz" in seen["system"] and "climby-timer" in seen["system"]
    seen = _answers(monkeypatch, "Fine.")
    assert _ask(h, lang="bg").status_code == 200
    assert "Умни възможности" in seen["system"]


def test_a_guest_and_the_photo_screen_get_nothing(monkeypatch):
    seen = _answers(monkeypatch, QUIZ + "\n" + TIMER)
    data = _ask().json()
    assert "climby-quiz" not in seen["system"]
    assert data["quiz"] is None and data["timer"] is None and data["plan"] == []
    assert FENCE not in data["answer"]
    _uid, h = _login("smart3@example.com")
    seen = _answers(monkeypatch, QUIZ)
    data = _ask(h, surface="tutor").json()
    assert "climby-quiz" not in seen["system"] and data["quiz"] is None


def test_the_parsers_never_raise_and_clamp():
    for raw in ("", "nope", "[]", "42", '{"cards": "x"}', '{"cards": [{"q": "only"}]}'):
        assert server_quiz(raw) is None
    cards = ",".join('{"q": "q%d", "a": "a"}' % i for i in range(20))
    assert len(server_quiz("[" + cards + "]")["cards"]) == 10
    assert server_timer('{"minutes": 1}')["minutes"] == 5
    assert server_timer('{"minutes": 999}')["minutes"] == 120
    assert server_timer('{"minutes": "soon"}') is None and server_timer("[]") is None


def test_a_plan_may_be_longer_than_a_task_offer():
    import server
    raw = "[" + ",".join('{"text": "Step %d"}' % i for i in range(12)) + "]"
    assert len(server._parse_task_block(raw, "en", server.MAX_PLAN_TASKS)) == 7
    assert len(server._parse_task_block(raw, "en")) == 3


def test_the_week_in_numbers_follows_what_memory_allows(monkeypatch):
    uid, h = _login("smart4@example.com")
    now = datetime.now(timezone.utc)
    db = SessionLocal()
    db.add_all([
        FocusSession(user_id=uid, duration_seconds=1800, created_at=now - timedelta(days=1)),
        FocusSession(user_id=uid, duration_seconds=3600, created_at=now - timedelta(days=30)),
        Task(user_id=uid, text="done", done=True, completed_at=now - timedelta(days=2)),
        Task(user_id=uid, text="old", done=True, completed_at=now - timedelta(days=20)),
    ])
    db.commit()
    db.close()
    seen = _answers(monkeypatch, "Good week.")
    _ask(h, memory={"focus_sessions": True, "checklist": True})
    assert "studied 30 minutes" in seen["system"]
    assert "finished 1 tasks" in seen["system"]
    seen = _answers(monkeypatch, "Good week.")
    _ask(h, memory={"learning_level": True})
    assert "This week" not in seen["system"], "nothing is read that memory did not allow"


def server_quiz(raw):
    import server
    return server._parse_quiz_block(raw)


def server_timer(raw):
    import server
    return server._parse_timer_block(raw)


def test_a_multiple_choice_card_keeps_options_and_the_right_index():
    raw = ('{"title": "T", "subject": "Maths", "cards": [{"q": "1/2+1/4", "options": ["2/6", "3/4", "1/6"], '
           '"correct": 1, "why": "Common denominator."}]}')
    quiz = server_quiz(raw)
    assert quiz["subject"] == "Maths"
    assert quiz["cards"] == [{"q": "1/2+1/4", "options": ["2/6", "3/4", "1/6"], "correct": 1,
                              "a": "3/4", "why": "Common denominator."}]


def test_a_card_whose_correct_index_is_wrong_falls_back_or_is_dropped():
    bad = '[{"q": "x", "options": ["a", "b"], "correct": 5}]'
    assert server_quiz(bad) is None, "no options that make sense and no answer: nothing to ask"
    fallback = '[{"q": "x", "options": ["a", "b"], "correct": true, "a": "b"}]'
    assert server_quiz(fallback)["cards"] == [{"q": "x", "a": "b", "why": ""}]
    one = '[{"q": "x", "options": ["only"], "correct": 0}]'
    assert server_quiz(one) is None