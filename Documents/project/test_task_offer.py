# -*- coding: utf-8 -*-
# test_task_offer.py — the tutor offering to put homework on the Route.
#
# The block it appends is machine-readable and the student must never see it,
# so most of these are about the strip: a model that writes the block wrongly,
# or writes it when it was not invited to, must still produce a clean answer.
#
# Run:  python -m pytest test_task_offer.py -q
import os
import tempfile
from datetime import date, timedelta

_tmp_db = os.path.join(tempfile.mkdtemp(), "offer.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import User  # noqa: E402

client = TestClient(server.app)

FENCE = "```"


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


def _answers(monkeypatch, text):
    """Make the model say exactly this, and report the system prompt it got."""
    seen = {}

    class _Block:
        type = "text"

    class _Resp:
        content = [_Block()]

    _Block.text = text

    def fake_create(**kwargs):
        seen["system"] = kwargs["system"]
        return _Resp()

    monkeypatch.setattr(server.client.messages, "create", fake_create)
    return seen


def _ask(headers=None, surface="chat", context=True, lang="en"):
    body = {"images": [], "question": "I have maths for tomorrow", "lang": lang,
            "context": context, "surface": surface}
    return client.post("/ask", json=body, headers=headers or {})


# --------------------------------------------------------------- the strip


def test_the_block_never_reaches_the_student():
    answer = f"Let's start with the hard one.\n\n{FENCE}climby-task\n[{{\"text\": \"Maths\"}}]\n{FENCE}"
    clean, marks = server._strip_marked_blocks(answer)
    assert clean == "Let's start with the hard one."
    assert FENCE not in clean and "climby-task" not in clean
    assert "Maths" in marks["task"]


def test_a_block_in_the_middle_leaves_the_words_around_it():
    answer = f"Before.\n{FENCE}climby-task\n[]\n{FENCE}\nAfter."
    clean, marks = server._strip_marked_blocks(answer)
    assert clean == "Before.\n\nAfter." or clean == "Before.\nAfter."
    assert FENCE not in clean


def test_an_unclosed_block_is_still_removed():
    """The answer can hit the token ceiling mid-block. Without the open-ended
    fallback the student would be left reading a half-written JSON array."""
    answer = f"Here you go.\n\n{FENCE}climby-task\n[{{\"text\": \"Maths\", \"subj"
    clean, marks = server._strip_marked_blocks(answer)
    assert clean == "Here you go."
    assert FENCE not in clean


def test_an_answer_with_no_block_is_untouched():
    answer = "Just an explanation, with a code sample:\n\n```python\nprint(1)\n```"
    clean, marks = server._strip_marked_blocks(answer)
    assert clean == answer.strip(), "an ordinary fenced code block must survive"
    assert marks == {}


def test_the_tag_may_be_written_in_any_case():
    answer = f"Sure.\n{FENCE}ClimbAI-Task\n[]\n{FENCE}"
    # only the climby- prefix is ours; a near miss is left alone rather than eaten
    clean, marks = server._strip_marked_blocks(answer)
    assert marks == {} and clean == answer.strip()
    answer = f"Sure.\n{FENCE}CLIMBY-TASK\n[]\n{FENCE}"
    clean, marks = server._strip_marked_blocks(answer)
    assert "task" in marks and FENCE not in clean


# --------------------------------------------------------------- the parse


def test_a_good_block_becomes_tasks():
    tasks = server._parse_task_block(
        '[{"text": "Maths — exercises 4-6, p. 32", "subject": "Maths", "deadline": "2030-05-20"}]', "en")
    assert tasks == [{"text": "Maths — exercises 4-6, p. 32", "subject": "Maths", "deadline": "2030-05-20"}]


def test_broken_json_is_no_tasks_rather_than_an_error():
    for raw in ('[{"text": ', "not json at all", "", "null", "42", '"a string"'):
        assert server._parse_task_block(raw, "en") == []


def test_a_single_task_need_not_be_wrapped_in_a_list():
    tasks = server._parse_task_block('{"text": "Read chapter 3"}', "en")
    assert len(tasks) == 1 and tasks[0]["text"] == "Read chapter 3"


def test_a_task_with_no_text_is_dropped():
    tasks = server._parse_task_block('[{"subject": "Maths"}, {"text": "   "}, {"text": "Real one"}]', "en")
    assert [t["text"] for t in tasks] == ["Real one"]


def test_a_date_the_route_cannot_store_is_dropped_not_kept():
    """A task is still worth offering without a deadline; a task carrying
    "tomorrow" in a date column is a row the Route cannot render."""
    tasks = server._parse_task_block('[{"text": "Maths", "deadline": "tomorrow"}]', "en")
    assert tasks[0]["deadline"] is None
    tasks = server._parse_task_block('[{"text": "Maths", "deadline": "2030-13-45"}]', "en")
    assert tasks[0]["deadline"] is None


def test_no_more_than_three_are_taken():
    raw = "[" + ",".join(f'{{"text": "Task {i}"}}' for i in range(9)) + "]"
    assert len(server._parse_task_block(raw, "en")) == 3


def test_long_fields_are_cut_to_what_the_route_accepts():
    raw = '[{"text": "%s", "subject": "%s"}]' % ("x" * 900, "y" * 300)
    t = server._parse_task_block(raw, "en")[0]
    assert len(t["text"]) == 500 and len(t["subject"]) == 100


# ------------------------------------------------------- who gets offered it


def test_a_signed_in_chat_is_invited_to_offer(monkeypatch):
    _uid, h = _login("offer1@example.com")
    seen = _answers(monkeypatch, "Fine.")
    assert _ask(h).status_code == 200
    assert "Adding to the Route" in seen["system"]
    assert date.today().isoformat() in seen["system"], "it needs today to read 'tomorrow'"
    assert (date.today() + timedelta(days=1)).isoformat() in seen["system"]


def test_a_guest_is_not(monkeypatch):
    seen = _answers(monkeypatch, "Fine.")
    assert _ask().status_code == 200
    assert "Adding to the Route" not in seen["system"], "a guest has no Route"


def test_the_photo_screen_is_not(monkeypatch):
    _uid, h = _login("offer2@example.com")
    seen = _answers(monkeypatch, "Fine.")
    assert _ask(h, surface="tutor").status_code == 200
    assert "Adding to the Route" not in seen["system"]


def test_the_offer_comes_in_the_students_language(monkeypatch):
    _uid, h = _login("offer3@example.com")
    seen = _answers(monkeypatch, "Добре.")
    assert _ask(h, lang="bg").status_code == 200
    assert "Добавяне в Маршрута" in seen["system"]


# ----------------------------------------------------------- end to end


def test_the_answer_arrives_clean_with_the_tasks_beside_it(monkeypatch):
    _uid, h = _login("offer4@example.com")
    _answers(monkeypatch,
             f"Maths first, then. Shall I put it on your Route?\n\n{FENCE}climby-task\n"
             f'[{{"text": "Maths — exercises 4-6", "subject": "Maths", "deadline": "2030-05-20"}}]\n{FENCE}')
    res = _ask(h)
    assert res.status_code == 200
    data = res.json()
    assert data["answer"] == "Maths first, then. Shall I put it on your Route?"
    assert FENCE not in data["answer"]
    assert data["suggestions"] == [
        {"text": "Maths — exercises 4-6", "subject": "Maths", "deadline": "2030-05-20"}]


def test_a_block_sent_where_it_was_not_invited_is_still_stripped(monkeypatch):
    """The prompt only asks for it in the chat, but a model may write one
    anywhere. It must never be read to a guest — and never be visible."""
    _answers(monkeypatch, f"Here.\n\n{FENCE}climby-task\n[{{\"text\": \"Maths\"}}]\n{FENCE}")
    res = _ask(surface="tutor")          # a guest, on the photo screen
    assert res.status_code == 200
    data = res.json()
    assert data["answer"] == "Here."
    assert FENCE not in data["answer"]
    assert data["suggestions"] == [], "not invited, so not read"


def test_an_ordinary_answer_carries_an_empty_list(monkeypatch):
    _uid, h = _login("offer5@example.com")
    _answers(monkeypatch, "A prime number has exactly two divisors.")
    data = _ask(h).json()
    assert data["answer"] == "A prime number has exactly two divisors."
    assert data["suggestions"] == []


def test_what_is_saved_to_history_has_no_block_in_it(monkeypatch):
    """Summited shows these answers back. A fenced lump of JSON would sit there
    for good."""
    uid, h = _login("offer6@example.com")
    _answers(monkeypatch, f"Noted.\n\n{FENCE}climby-task\n[{{\"text\": \"Maths\"}}]\n{FENCE}")
    assert _ask(h).status_code == 200
    from models import ScanHistory
    db = SessionLocal()
    row = (db.query(ScanHistory)
           .filter(ScanHistory.user_id == uid)
           .order_by(ScanHistory.id.desc()).first())
    saved = row.answer
    db.close()
    assert saved == "Noted."
    assert FENCE not in saved
