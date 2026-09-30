# -*- coding: utf-8 -*-
# test_relay.py — Opus reads the page once, Haiku teaches from it.
#
# The reader and the tutor both go through client.beta.messages.create, so the
# fake below answers according to which model was asked. Everything that
# matters to a student is here: the page is read once, the solution never
# leaves the server, a stranger's page cannot be borrowed, and a reader that
# fails leaves the conversation exactly where it was before the relay existed.
#
# Run:  python -m pytest test_relay.py -q
import os
import tempfile

_tmp_db = os.path.join(tempfile.mkdtemp(), "relay.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import relay  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import ProblemBrief, User  # noqa: E402

client = TestClient(server.app)

# A real, decodable 1x1 JPEG, so the image type check passes.
JPEG = ("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////"
        "////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgB"
        "AQABPxA=")

SOLUTION = "Mass points: A:B:C = 1:2:2, so S_AON = 4S/15 and S = 30 cm2."
READ = "Problem 22: AP:PC = 2:1, M midpoint of BC, S_AON = 8. Asked: S_ABC."


class _Text:
    type = "text"

    def __init__(self, text):
        self.text = text


class _Block:
    def __init__(self, type_):
        self.type = type_


class _Resp:
    def __init__(self, blocks, stop="end_turn"):
        self.content = blocks
        self.stop_reason = stop


def _fake(monkeypatch, reader_text=None, reader_error=None, reader_stop="end_turn",
          tutor_blocks=None):
    """Stub both models. Returns the list of calls, in order."""
    calls = []
    if reader_text is None:
        reader_text = (f"<subject>maths</subject>\n<read>{READ}</read>\n"
                       f"<solution>{SOLUTION}</solution>")

    def create(**kw):
        calls.append(kw)
        if kw["model"] == relay.READER_MODEL:
            if reader_error:
                raise reader_error
            return _Resp([_Text(reader_text)], stop=reader_stop)
        return _Resp(tutor_blocks or [_Text("Start with the ratio AP:PC.")])

    monkeypatch.setattr(server.client.beta.messages, "create", create)
    monkeypatch.setattr(server.client.messages, "create", create)
    monkeypatch.setattr(server.reader_client.beta.messages, "create", create)
    return calls


def _login(email):
    rate_limit._hits.clear()
    client.post("/auth/register", json={"display_name": "A", "email": email, "password": "testpass123"})
    db = SessionLocal()
    u = db.query(User).filter(User.email == email).first()
    u.is_email_verified = True
    db.commit()
    db.close()
    res = client.post("/auth/login", json={"email": email, "password": "testpass123"})
    return {"Authorization": f"Bearer {res.json()['token']}"}


def _ask(headers=None, **body):
    rate_limit._hits.clear()
    payload = {"images": [], "question": "How do I solve 22?", "lang": "en", "surface": "tutor"}
    payload.update(body)
    return client.post("/ask", json=payload, headers=headers or {})


def _readers(calls):
    return [c for c in calls if c["model"] == relay.READER_MODEL]


def _tutors(calls):
    return [c for c in calls if c["model"] != relay.READER_MODEL]


def _has_image(call):
    return any(part.get("type") == "image"
               for m in call["messages"] for part in m["content"])


# ------------------------------------------------------------ read once


def test_a_new_photo_is_read_by_opus_and_taught_by_haiku(monkeypatch):
    calls = _fake(monkeypatch)
    res = _ask(images=[JPEG])
    assert res.status_code == 200, res.text
    assert len(_readers(calls)) == 1
    assert len(_tutors(calls)) == 1
    # Haiku is given the page as text, not the photographs
    assert not _has_image(_tutors(calls)[0])
    assert READ in _tutors(calls)[0]["system"]
    data = res.json()
    assert data["brief_id"]
    assert data["read"] == READ


def test_a_follow_up_is_not_read_again(monkeypatch):
    calls = _fake(monkeypatch)
    first = _ask(images=[JPEG]).json()
    calls.clear()
    res = _ask(brief_id=first["brief_id"], question="I got AO:OM = 3:2?",
               history=[{"role": "user", "text": "How do I solve 22?"},
                        {"role": "assistant", "text": "Start with the ratio."}])
    assert res.status_code == 200, res.text
    assert _readers(calls) == [], "the page was read a second time"
    assert READ in _tutors(calls)[0]["system"]
    assert not _has_image(_tutors(calls)[0])
    # what was read is shown once, on the first answer only
    assert res.json()["read"] is None
    assert res.json()["brief_id"] == first["brief_id"]


def test_an_old_client_resending_photos_on_a_follow_up_is_not_read_again(monkeypatch):
    """Copies installed before the relay send the photographs on every turn and
    never send brief_id. Reading each of those would put 35 seconds and an Opus
    call on every follow-up they make until they update."""
    calls = _fake(monkeypatch)
    res = _ask(images=[JPEG], question="And now?",
               history=[{"role": "user", "text": "How do I solve 22?"},
                        {"role": "assistant", "text": "Start with the ratio."}])
    assert res.status_code == 200
    assert _readers(calls) == []
    assert _has_image(_tutors(calls)[0]), "the old behaviour: Haiku reads the photos"


# ------------------------------------------------------- the hidden solution


def test_the_solution_reaches_haiku_and_never_the_student(monkeypatch):
    calls = _fake(monkeypatch)
    res = _ask(images=[JPEG])
    assert SOLUTION in _tutors(calls)[0]["system"]
    assert SOLUTION not in res.text, "the worked solution left the server"
    assert "30 cm2" not in res.json()["read"]


def test_the_solution_is_only_kept_for_subjects_that_have_one(monkeypatch):
    calls = _fake(monkeypatch, reader_text=(
        "<subject>other</subject>\n<read>An essay prompt about Vazov.</read>\n"
        "<solution>This should not be kept.</solution>"))
    res = _ask(images=[JPEG])
    assert res.status_code == 200
    assert "This should not be kept." not in _tutors(calls)[0]["system"]
    db = SessionLocal()
    brief = db.get(ProblemBrief, res.json()["brief_id"])
    assert brief.solution_text is None and brief.subject == "other"
    db.close()


def test_geometry_counts_as_maths():
    """The reader is asked for one of four words and mostly gives one; a
    'geometry' must not quietly cost the student their worked solution."""
    for raw, want in [("maths", "maths"), ("Geometry", "maths"), ("mathematics.", "maths"),
                      ("физика", "physics"), ("chemistry", "chemistry"),
                      ("history", "other"), ("", "other"), (None, "other")]:
        assert relay._subject(raw) == want, raw


# ------------------------------------------------------------- ownership


def test_a_page_read_for_one_account_cannot_be_used_by_another(monkeypatch):
    _fake(monkeypatch)
    mine = _login("relay-owner@example.com")
    brief_id = _ask(mine, images=[JPEG]).json()["brief_id"]
    theirs = _login("relay-other@example.com")
    res = _ask(theirs, brief_id=brief_id)
    assert res.status_code == 410
    # and a guest cannot borrow it either
    assert _ask(brief_id=brief_id).status_code == 410


def test_a_guests_page_works_for_the_guest(monkeypatch):
    _fake(monkeypatch)
    brief_id = _ask(images=[JPEG]).json()["brief_id"]
    assert _ask(brief_id=brief_id).status_code == 200


def test_an_unknown_page_asks_for_the_photos_again(monkeypatch):
    _fake(monkeypatch)
    res = _ask(brief_id="00000000-0000-0000-0000-000000000000")
    assert res.status_code == 410
    assert isinstance(res.json()["detail"], str)


# ------------------------------------------------------------- degradation


def test_a_reader_that_fails_leaves_haiku_reading_the_photos(monkeypatch):
    calls = _fake(monkeypatch, reader_error=RuntimeError("overloaded"))
    res = _ask(images=[JPEG])
    assert res.status_code == 200, "a failed reader must never reach the student"
    assert _has_image(_tutors(calls)[0]), "Haiku should have been given the photographs"
    assert res.json()["brief_id"] is None


def test_a_reader_that_declines_is_the_same_as_one_that_fails(monkeypatch):
    calls = _fake(monkeypatch, reader_stop="refusal")
    res = _ask(images=[JPEG])
    assert res.status_code == 200
    assert _has_image(_tutors(calls)[0])
    assert res.json()["brief_id"] is None


def test_a_reader_answer_in_the_wrong_shape_is_a_failure(monkeypatch):
    calls = _fake(monkeypatch, reader_text="I can see a triangle.")
    res = _ask(images=[JPEG])
    assert res.status_code == 200
    assert _has_image(_tutors(calls)[0])


# ------------------------------------------------------------------ tools


def test_the_tutor_has_the_advisor_and_a_fenced_search(monkeypatch):
    calls = _fake(monkeypatch)
    _ask(surface="chat", question="Prove the angle bisector theorem.")
    tools = {t["name"]: t for t in _tutors(calls)[0]["tools"]}
    adv = tools["advisor"]
    assert adv["model"] == relay.ADVISOR_MODEL
    assert adv["max_uses"] == 1, "one consultation per message — do not overdo it"
    assert adv["max_tokens"] == 2000, "uncapped it took 82 seconds"
    search = tools["web_search"]
    for site in ("domashno.bg", "zadachite.net", "gdz.ru"):
        assert site in search["blocked_domains"], f"{site} is an answer key"
    assert relay.ADVISOR_BETA in _tutors(calls)[0]["betas"]


def test_the_rules_for_the_tools_come_in_the_students_language(monkeypatch):
    calls = _fake(monkeypatch)
    _ask(lang="bg", surface="chat", question="Как да започна?")
    system = _tutors(calls)[0]["system"]
    assert "съветника" in system and "Никога не търси отговора" in system


def test_the_consultation_is_not_narrated_to_the_student(monkeypatch):
    """Measured: Haiku wrote 'let me consult on the best method' before the
    tool call. Only what comes after the last tool round-trip is kept."""
    _fake(monkeypatch, tutor_blocks=[
        _Text("Let me consult on the best method first."),
        _Block("server_tool_use"),
        _Block("advisor_tool_result"),
        _Text("Look at triangles AON and BON."),
    ])
    res = _ask(surface="chat", question="How do I start?")
    assert res.json()["answer"] == "Look at triangles AON and BON."


def test_an_answer_with_no_tools_is_kept_whole():
    class R:
        content = [_Text("Part one. "), _Text("Part two.")]
    assert relay.answer_text(R()) == "Part one. Part two."


# ------------------------------------------------------- answer on request


def test_the_tutor_gives_the_answer_when_asked():
    """Decided: if the student asks for the answer, they get it. The old rule
    kept the last step back even then."""
    for lang in ("en", "bg"):
        assert "leave the last step to them" not in server.SYSTEM[lang]
        assert "остави последната стъпка на него" not in server.SYSTEM[lang]
    assert "give it — fully explained" in server.SYSTEM["en"]
    assert "дай му го" in server.SYSTEM["bg"]


# ------------------------------------------------------------ the account


def test_deleting_an_account_deletes_its_pages(monkeypatch):
    _fake(monkeypatch)
    h = _login("relay-delete@example.com")
    brief_id = _ask(h, images=[JPEG]).json()["brief_id"]
    rate_limit._hits.clear()
    res = client.request("DELETE", "/account", json={"password": "testpass123"}, headers=h)
    assert res.status_code == 200, res.text
    db = SessionLocal()
    assert db.get(ProblemBrief, brief_id) is None
    db.close()


def test_the_export_includes_what_was_read(monkeypatch):
    _fake(monkeypatch)
    h = _login("relay-export@example.com")
    _ask(h, images=[JPEG])
    rate_limit._hits.clear()
    data = client.get("/account/export", headers=h).json()
    pages = data["photographed_pages"]
    assert len(pages) == 1
    assert pages[0]["what_was_read"] == READ
    # the student's own data includes the solution, even if the tutor holds it back
    assert pages[0]["worked_solution"] == SOLUTION


def test_the_reader_is_tried_once_with_a_hard_stop():
    """Two SDK retries on a 75 s timeout is almost four minutes; the app gives up
    long before, and the student sees an error instead of the fallback."""
    assert server.reader_client.max_retries == 0
    assert server.client.max_retries > 0, "the tutor call keeps its retries"
    assert relay.READER_TIMEOUT_S <= 80


def test_the_reader_call_carries_the_timeout(monkeypatch):
    calls = _fake(monkeypatch)
    rate_limit._hits.clear()
    res = client.post("/ask", json={"images": [JPEG], "question": "22?", "lang": "en"})
    assert res.status_code == 200
    reader = [c for c in calls if c["model"] == relay.READER_MODEL]
    assert reader and reader[0]["timeout"] == relay.READER_TIMEOUT_S
