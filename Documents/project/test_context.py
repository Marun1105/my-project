# test_context.py — what the chat tutor is told about the student.
#
# Run:  python -m pytest test_context.py -q
import os
import tempfile
from datetime import date

_tmp_db = os.path.join(tempfile.mkdtemp(), "context.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import ScanHistory, Task, User  # noqa: E402

client = TestClient(server.app)


def _login(email):
    rate_limit._hits.clear()
    client.post("/auth/register", json={"display_name": "A", "email": email, "password": "testpass123"})
    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    user.is_email_verified = True
    db.commit()
    uid = user.id
    db.close()
    res = client.post("/auth/login", json={"email": email, "password": "testpass123"})
    return uid, {"Authorization": f"Bearer {res.json()['token']}"}


def _capture(monkeypatch):
    """Stub Anthropic and hand back whatever system prompt it was given."""
    seen = {}

    class _Block:
        type = "text"
        text = "Answer."

    class _Resp:
        content = [_Block()]

    def fake_create(**kwargs):
        seen["system"] = kwargs["system"]
        return _Resp()

    monkeypatch.setattr(server.client.messages, "create", fake_create)
    return seen


def _ask(headers=None, context=True, lang="en", surface=None):
    body = {"images": [], "question": "What should I start with?", "lang": lang, "context": context}
    if surface:
        body["surface"] = surface
    return client.post("/ask", json=body, headers=headers or {})


def test_a_signed_in_chat_sees_the_route_and_recent_questions(monkeypatch):
    uid, h = _login("ctx@example.com")
    db = SessionLocal()
    db.add(Task(user_id=uid, text="Problems 4-8, p. 32", subject="Math", deadline=date(2030, 5, 20)))
    db.add(Task(user_id=uid, text="Read chapter 3", subject="History"))
    db.add(Task(user_id=uid, text="Already done", done=True))
    db.add(ScanHistory(user_id=uid, question="What is a prime number?", answer="…"))
    db.commit()
    db.close()

    seen = _capture(monkeypatch)
    assert _ask(h).status_code == 200
    system = seen["system"]
    assert "Problems 4-8, p. 32" in system and "Math" in system and "2030-05-20" in system
    assert "Read chapter 3" in system
    assert "What is a prime number?" in system
    assert "Already done" not in system, "finished tasks are not the Route"
    # the rules travel with the data
    assert "never list it unprompted" in system


def test_a_guest_gets_nothing_even_if_they_ask_for_it(monkeypatch):
    seen = _capture(monkeypatch)
    assert _ask(None, context=True).status_code == 200
    assert "What you know about this student" not in seen["system"]


def test_without_the_flag_nothing_is_added(monkeypatch):
    """The photo tutor doesn't ask for it, and shouldn't pay for it."""
    uid, h = _login("noflag@example.com")
    db = SessionLocal()
    db.add(Task(user_id=uid, text="Something pending"))
    db.commit()
    db.close()
    seen = _capture(monkeypatch)
    assert _ask(h, context=False).status_code == 200
    assert "Something pending" not in seen["system"]


def test_an_empty_route_and_no_history_adds_nothing(monkeypatch):
    _, h = _login("empty@example.com")
    seen = _capture(monkeypatch)
    _ask(h)
    assert "What you know about this student" not in seen["system"]


def test_the_block_is_capped(monkeypatch):
    """Every token here is paid on every turn of every chat."""
    uid, h = _login("cap@example.com")
    db = SessionLocal()
    for i in range(30):
        db.add(Task(user_id=uid, text=f"task {i:02d}"))
        db.add(ScanHistory(user_id=uid, question=f"question {i:02d}", answer="…"))
    db.commit()
    db.close()
    seen = _capture(monkeypatch)
    _ask(h)
    system = seen["system"]
    assert system.count("- task ") == server.CONTEXT_MAX_TASKS
    assert system.count("- question ") == server.CONTEXT_MAX_QUESTIONS


def test_one_students_route_never_reaches_anothers_tutor(monkeypatch):
    a, ha = _login("a@example.com")
    b, hb = _login("b@example.com")
    db = SessionLocal()
    db.add(Task(user_id=a, text="A's secret homework"))
    db.commit()
    db.close()
    seen = _capture(monkeypatch)
    _ask(hb)
    assert "A's secret homework" not in seen["system"]


def test_the_rules_come_in_the_students_language(monkeypatch):
    uid, h = _login("bg@example.com")
    db = SessionLocal()
    db.add(Task(user_id=uid, text="Задачи 4–8"))
    db.commit()
    db.close()
    seen = _capture(monkeypatch)
    _ask(h, lang="bg")
    assert "Какво знаеш за този ученик" in seen["system"]
    assert "Чакащи задачи" in seen["system"]


def test_the_tutor_speaks_to_the_grade(monkeypatch):
    uid, h = _login("grade@example.com")
    client.patch("/account/profile", json={"grade": 10}, headers=h)
    seen = _capture(monkeypatch)
    _ask(h, context=False)
    assert "grade 10" in seen["system"] and "capable young adult" in seen["system"]

    client.patch("/account/profile", json={"grade": 2}, headers=h)
    _ask(h, context=False)
    assert "grade 2" in seen["system"] and "short sentences" in seen["system"]
    assert "capable young adult" not in seen["system"]


def test_without_a_grade_the_tutor_is_told_nothing_about_age(monkeypatch):
    _, h = _login("nograde@example.com")
    seen = _capture(monkeypatch)
    _ask(h, context=False)
    assert "The student is in grade" not in seen["system"]
    _ask(None, context=False)   # a guest
    assert "The student is in grade" not in seen["system"]


# ---------------------------------------------------------------------------
# What the tutor knows about the app it is standing in. It used to know none of
# it: it could not say where Settings was, it invented buttons when asked, and
# the chat offered to look at photographs that have no way of reaching it.
# ---------------------------------------------------------------------------


def test_the_chat_is_told_it_cannot_see_photographs(monkeypatch):
    seen = _capture(monkeypatch)
    assert _ask(surface="chat").status_code == 200
    system = seen["system"]
    assert "CANNOT see photographs" in system
    assert "photograph it on the ClimbAI screen" in system
    # and it must not also be carrying the photo-reading instructions
    assert "parts of the same problem" not in system


def test_the_photo_screen_is_told_the_photographs_may_be_there(monkeypatch):
    seen = _capture(monkeypatch)
    assert _ask(surface="tutor").status_code == 200
    system = seen["system"]
    assert "parts of the same problem" in system
    assert "CANNOT see photographs" not in system


def test_a_request_that_names_no_screen_is_treated_as_the_photo_screen(monkeypatch):
    """Old clients, and anything else posting to /ask, keep the behaviour they
    had before the field existed."""
    seen = _capture(monkeypatch)
    assert _ask().status_code == 200
    assert "parts of the same problem" in seen["system"]


def test_a_made_up_screen_is_refused(monkeypatch):
    _capture(monkeypatch)
    body = {"images": [], "question": "hi", "lang": "en", "surface": "kitchen"}
    assert client.post("/ask", json=body).status_code == 422


def test_the_tutor_is_told_what_a_route_is(monkeypatch):
    """_student_context has been handing it the phrase "their Route" since the
    context feature shipped, with nothing anywhere defining the word."""
    seen = _capture(monkeypatch)
    assert _ask().status_code == 200
    system = seen["system"]
    assert "The Route — the student's task list" in system
    assert "Summited" in system and "Ascent" in system and "Rope Team" in system


def test_the_tutor_is_told_not_to_invent_buttons(monkeypatch):
    """It is now a help desk, so the failure mode is a confident wrong answer
    about the app. The way out has to be in the prompt."""
    seen = _capture(monkeypatch)
    assert _ask().status_code == 200
    assert "Never invent a button" in seen["system"]


def test_both_languages_carry_the_map(monkeypatch):
    seen = _capture(monkeypatch)
    assert _ask(lang="bg").status_code == 200
    system = seen["system"]
    assert "Къде се намираш" in system
    assert "Маршрутът (The Route)" in system
    assert "не измисляй бутон" in system


def test_the_bulgarian_chat_is_told_it_has_no_photographs(monkeypatch):
    seen = _capture(monkeypatch)
    assert _ask(lang="bg", surface="chat").status_code == 200
    assert "ТУК НЕ ВИЖДАШ снимки" in seen["system"]
