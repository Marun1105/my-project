# -*- coding: utf-8 -*-
# test_solved.py — the one number that goes up when the student needs less help.
#
# Every other number in the app rises when a student leans on the tutor harder:
# questions asked, minutes sat, tasks ticked. That is the wrong way round for a
# teaching app, and it would be worse as a scoreboard — the way to win would be
# to ask more. This one counts the moments the student produced the step
# themselves, judged by the tutor, unclaimable by the student.
#
# Run:  python -m pytest test_solved.py -q
import os
import tempfile

_tmp_db = os.path.join(tempfile.mkdtemp(), "solved.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import ScanHistory, User  # noqa: E402

client = TestClient(server.app)

FENCE = "```"
SOLVED = f"{FENCE}climby-solved\n{{}}\n{FENCE}"


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


def _ask(headers=None, surface="chat", lang="en"):
    rate_limit._hits.clear()
    return client.post("/ask", json={"images": [], "question": "is it 12?", "lang": lang,
                                     "context": True, "surface": surface}, headers=headers or {})


def _rows(uid):
    db = SessionLocal()
    rows = (db.query(ScanHistory).filter(ScanHistory.user_id == uid)
            .order_by(ScanHistory.created_at).all())
    out = [(r.answer, r.solved_unaided) for r in rows]
    db.close()
    return out


# ------------------------------------------------------------- the marker


def test_the_marker_never_reaches_the_student(monkeypatch):
    uid, h = _login("solved1@example.com")
    _answers(monkeypatch, f"Yes — that's exactly it.\n\n{SOLVED}")
    data = _ask(h).json()
    assert data["answer"] == "Yes — that's exactly it."
    assert FENCE not in data["answer"] and "climby-solved" not in data["answer"]
    assert data["solved"] is True


def test_it_is_recorded_against_the_exchange(monkeypatch):
    uid, h = _login("solved2@example.com")
    _answers(monkeypatch, f"Right.\n\n{SOLVED}")
    assert _ask(h).status_code == 200
    assert _rows(uid) == [("Right.", True)]


def test_an_ordinary_answer_records_nothing(monkeypatch):
    uid, h = _login("solved3@example.com")
    _answers(monkeypatch, "Start by finding the midpoint.")
    data = _ask(h).json()
    assert data["solved"] is False
    assert _rows(uid) == [("Start by finding the midpoint.", False)]


def test_a_guest_earns_nothing(monkeypatch):
    """No account, nowhere to count it — and the prompt should not even ask."""
    seen = _answers(monkeypatch, f"Right.\n\n{SOLVED}")
    data = _ask().json()
    assert data["solved"] is False
    assert "climby-solved" not in seen["system"]
    # but it is still stripped, so it cannot be seen
    assert FENCE not in data["answer"]


def test_the_photo_screen_counts_too(monkeypatch):
    """A step worked out alone on a photographed problem is the same thing."""
    uid, h = _login("solved4@example.com")
    seen = _answers(monkeypatch, f"Exactly right.\n\n{SOLVED}")
    data = _ask(h, surface="tutor").json()
    assert "climby-solved" in seen["system"]
    assert data["solved"] is True


def test_the_instruction_comes_in_both_languages(monkeypatch):
    uid, h = _login("solved5@example.com")
    seen = _answers(monkeypatch, "Добре.")
    assert _ask(h, lang="bg").status_code == 200
    assert "стигне САМ" in seen["system"]
    assert "Не когато ти си дал цялото решение" in seen["system"]


def test_the_instruction_says_when_not_to(monkeypatch):
    """Without the refusals it would fire on thanks and on agreement, and the
    number would mean nothing."""
    uid, h = _login("solved6@example.com")
    seen = _answers(monkeypatch, "Fine.")
    assert _ask(h).status_code == 200
    system = seen["system"]
    assert "Not when you gave the full solution" in system
    assert "Not on the first message" in system
    assert "said thank you" in system


# --------------------------------------------------- one stripper, every marker


def test_every_climby_marker_is_stripped_not_just_the_known_ones():
    """Naming each marker means the next one added leaks onto the screen and
    the same bug is filed again."""
    answer = f"Here.\n{FENCE}climby-something-new\n[1,2]\n{FENCE}"
    clean, marks = server._strip_marked_blocks(answer)
    assert clean == "Here."
    assert FENCE not in clean
    assert "something-new" in marks


def test_two_markers_in_one_answer_both_go():
    answer = (f"Well done.\n{FENCE}climby-solved\n{{}}\n{FENCE}\n"
              f"{FENCE}climby-task\n[{{\"text\":\"Maths\"}}]\n{FENCE}")
    clean, marks = server._strip_marked_blocks(answer)
    assert clean == "Well done."
    assert set(marks) == {"solved", "task"}


def test_an_ordinary_code_block_survives():
    answer = f"Like this:\n\n{FENCE}python\nprint(1)\n{FENCE}"
    clean, marks = server._strip_marked_blocks(answer)
    assert clean == answer.strip()
    assert marks == {}


# ------------------------------------------------------------- the home line


def test_the_activity_feed_reports_it_as_its_own_event(monkeypatch):
    uid, h = _login("solved7@example.com")
    _answers(monkeypatch, f"Right.\n\n{SOLVED}")
    assert _ask(h).status_code == 200
    _answers(monkeypatch, "Try the midpoint first.")
    assert _ask(h).status_code == 200

    res = client.get("/activity", headers=h)
    assert res.status_code == 200
    kinds = [e["kind"] for e in res.json()["events"]]
    assert kinds.count("question") == 2, "both exchanges are still questions"
    assert kinds.count("solved") == 1, "only one of them was solved unaided"


def test_no_raw_sql_compares_a_boolean_to_a_number():
    """The suite runs on SQLite, where `solved_unaided = 1` is fine. Postgres
    has no boolean = integer operator and the query fails only in production —
    the same trap that once stopped the server booting at all."""
    import re
    here = os.path.dirname(__file__)
    for name in ("activity.py", "migrations.py", "server.py"):
        with open(os.path.join(here, name), encoding="utf-8") as f:
            src = f.read()
        for bad in re.findall(r"solved_unaided\s*=\s*[01]\b", src):
            raise AssertionError(f"{name}: {bad!r} — use TRUE/FALSE, not 1/0")
