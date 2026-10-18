# test_crew.py — Crew: setting up, the age rule, friends, blocks, holds.
#
# Run:  python -m pytest test_crew.py -q
import os
import tempfile
from datetime import date, datetime, timedelta, timezone

_tmp_db = os.path.join(tempfile.mkdtemp(), "crew.db")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp_db}")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("TRUSTED_PROXY_HOPS", "0")

from fastapi.testclient import TestClient  # noqa: E402

import crew  # noqa: E402
import holds  # noqa: E402
import rate_limit  # noqa: E402
from conftest import phone_for_test_account  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import FamilyLink, FocusSession, HoldEntry, SocialProfile, Task, User  # noqa: E402

client = TestClient(server.app)
TINY_JPEG = ("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////"
             "//////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAA"
             "AAAAAAAAAP/aAAgBAQABPxA=")


def _login(email, role="student"):
    rate_limit._hits.clear()
    client.post("/auth/register", json={
        "display_name": email.split("@")[0].title(), "email": email,
        "phone": phone_for_test_account(email), "password": "testpass123",
    })
    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    user.is_email_verified = True
    user.is_phone_verified = True
    user.role = role
    db.commit()
    uid = user.id
    db.close()
    res = client.post("/auth/login", json={"email": email, "password": "testpass123"})
    return uid, {"Authorization": f"Bearer {res.json()['token']}"}


def _year(age):
    # born in January, so the age is the same all year
    return date.today().year - age


def _setup(h, username, age=14):
    rate_limit._hits.clear()
    return client.post("/crew/profile", json={"birth_year": _year(age), "birth_month": 1, "username": username}, headers=h)


def _friends(ha, hb, b_name, a_name):
    assert client.post("/crew/requests", json={"username": b_name}, headers=ha).json()["status"] == "sent"
    assert client.post("/crew/requests/accept", json={"username": a_name}, headers=hb).json()["status"] == "friends"


# ---------------------------------------------------------------------------
# setting up
# ---------------------------------------------------------------------------

def test_crew_asks_to_be_set_up_first():
    _, h = _login("crew-new@example.com")
    assert client.get("/crew", headers=h).json()["needs"] == "setup"


def test_setting_up_opens_the_mountain():
    _, h = _login("crew-setup@example.com")
    res = _setup(h, "Setup.One")
    assert res.status_code == 200
    data = res.json()
    assert data["needs"] is None
    assert data["me"]["username"] == "setup.one"        # stored in lower case
    assert data["friends"] == [] and data["me"]["holds_total"] == 0


def test_usernames_are_checked_and_unique():
    _, h1 = _login("crew-u1@example.com")
    _, h2 = _login("crew-u2@example.com")
    for bad in ("ab", "-dash", "has space", "climby", "end.", "a..b"):
        assert _setup(h1, bad).status_code in (400, 422), bad
    assert _setup(h1, "taken_name").status_code == 200
    assert _setup(h2, "TAKEN_NAME").status_code == 409


def test_the_birth_date_is_set_once_and_must_be_plausible():
    _, h = _login("crew-birth@example.com")
    assert client.post("/crew/profile", json={"birth_year": _year(3), "birth_month": 1, "username": "baby_one"},
                       headers=h).status_code == 400
    assert _setup(h, "birth_once", age=14).status_code == 200
    again = client.post("/crew/profile", json={"birth_year": _year(18), "birth_month": 1, "username": "birth_once"}, headers=h)
    assert again.status_code == 409


def test_crew_is_for_students():
    _, h = _login("crew-parent-role@example.com", role="parent")
    assert client.get("/crew", headers=h).json()["needs"] == "role"
    assert _setup(h, "parent_x").status_code == 403


# ---------------------------------------------------------------------------
# the age rule
# ---------------------------------------------------------------------------

def test_under_the_age_a_linked_parent_has_to_say_yes():
    kid, hk = _login("crew-kid@example.com")
    parent, hp = _login("crew-kid-parent@example.com", role="parent")
    res = _setup(hk, "little_one", age=crew.PARENT_APPROVAL_UNDER - 2)
    assert res.json()["needs"] == "parent"
    assert res.json()["has_parent"] is False

    db = SessionLocal()
    db.add(FamilyLink(parent_user_id=parent, student_user_id=kid))
    db.commit(); db.close()
    assert client.get("/crew", headers=hk).json()["has_parent"] is True

    listed = client.get("/crew/approvals", headers=hp).json()
    assert listed == [{"student_id": kid, "needs_approval": True, "approved": False}]
    assert client.post("/crew/approvals", json={"student_id": kid, "allow": True}, headers=hp).status_code == 200
    assert client.get("/crew", headers=hk).json()["needs"] is None

    # unlinking the parent takes the approval with it
    db = SessionLocal()
    db.query(FamilyLink).filter(FamilyLink.student_user_id == kid).delete()
    db.commit(); db.close()
    assert client.get("/crew", headers=hk).json()["needs"] == "parent"


def test_only_a_linked_parent_can_approve():
    kid, hk = _login("crew-kid2@example.com")
    _, stranger = _login("crew-stranger-parent@example.com", role="parent")
    _setup(hk, "little_two", age=crew.PARENT_APPROVAL_UNDER - 1)
    assert client.post("/crew/approvals", json={"student_id": kid, "allow": True}, headers=stranger).status_code == 404


def test_a_young_student_cannot_be_found_before_approval():
    _, hk = _login("crew-kid3@example.com")
    _, ho = _login("crew-older3@example.com")
    _setup(hk, "hidden_kid", age=crew.PARENT_APPROVAL_UNDER - 1)
    _setup(ho, "older_three")
    assert client.get("/crew/search?q=hidden", headers=ho).json() == []
    assert client.post("/crew/requests", json={"username": "hidden_kid"}, headers=ho).status_code == 404


# ---------------------------------------------------------------------------
# friends
# ---------------------------------------------------------------------------

def test_a_request_and_an_accept_make_friends_both_ways():
    _, ha = _login("crew-fa@example.com")
    _, hb = _login("crew-fb@example.com")
    _setup(ha, "friend_a"); _setup(hb, "friend_b")
    assert client.get("/crew", headers=hb).json()["incoming"] == []
    assert client.post("/crew/requests", json={"username": "@Friend_B"}, headers=ha).json()["status"] == "sent"
    incoming = client.get("/crew", headers=hb).json()["incoming"]
    assert [p["username"] for p in incoming] == ["friend_a"]
    assert client.post("/crew/requests/accept", json={"username": "friend_a"}, headers=hb).json()["status"] == "friends"
    assert [p["username"] for p in client.get("/crew", headers=ha).json()["friends"]] == ["friend_b"]
    assert [p["username"] for p in client.get("/crew", headers=hb).json()["friends"]] == ["friend_a"]
    assert client.get("/crew", headers=hb).json()["incoming"] == []


def test_asking_back_is_saying_yes():
    _, ha = _login("crew-ma@example.com")
    _, hb = _login("crew-mb@example.com")
    _setup(ha, "mutual_a"); _setup(hb, "mutual_b")
    client.post("/crew/requests", json={"username": "mutual_b"}, headers=ha)
    assert client.post("/crew/requests", json={"username": "mutual_a"}, headers=hb).json()["status"] == "friends"


def test_search_finds_by_username_but_shows_strangers_no_numbers():
    _, ha = _login("crew-sa@example.com")
    sb, hb = _login("crew-sb@example.com")
    _setup(ha, "searcher_a"); _setup(hb, "zebra_found")
    db = SessionLocal()
    holds.award(db, sb, "solved", "q1", 3)
    db.commit(); db.close()
    found = client.get("/crew/search?q=zeb", headers=ha).json()
    assert [p["username"] for p in found] == ["zebra_found"]
    assert found[0]["holds_total"] == 0 and found[0]["live"] is False
    assert client.get("/crew/search?q=ze", headers=ha).json() == []          # three letters at least
    assert client.get("/crew/search?q=%25", headers=ha).json() == []         # no wildcards


def test_a_block_is_total_and_silent():
    _, ha = _login("crew-ba@example.com")
    _, hb = _login("crew-bb@example.com")
    _setup(ha, "blocker_a"); _setup(hb, "blocked_b")
    _friends(ha, hb, "blocked_b", "blocker_a")
    assert client.post("/crew/block", json={"username": "blocked_b"}, headers=ha).status_code == 200
    assert client.get("/crew", headers=ha).json()["friends"] == []
    assert client.get("/crew", headers=hb).json()["friends"] == []
    assert client.get("/crew/search?q=blocker", headers=hb).json() == []
    assert client.get("/crew/search?q=blocked", headers=ha).json() == []
    assert client.post("/crew/requests", json={"username": "blocker_a"}, headers=hb).status_code == 404


def test_unfriend_and_decline():
    _, ha = _login("crew-ua@example.com")
    _, hb = _login("crew-ub@example.com")
    _setup(ha, "unf_a"); _setup(hb, "unf_b")
    _friends(ha, hb, "unf_b", "unf_a")
    client.post("/crew/unfriend", json={"username": "unf_b"}, headers=ha)
    assert client.get("/crew", headers=hb).json()["friends"] == []
    client.post("/crew/requests", json={"username": "unf_b"}, headers=ha)
    client.post("/crew/requests/decline", json={"username": "unf_a"}, headers=hb)
    assert client.get("/crew", headers=hb).json()["incoming"] == []
    assert client.get("/crew", headers=ha).json()["outgoing"] == []


def test_friends_of_friends_are_suggested():
    _, ha = _login("crew-fofa@example.com")
    _, hb = _login("crew-fofb@example.com")
    _, hc = _login("crew-fofc@example.com")
    _setup(ha, "fof_a"); _setup(hb, "fof_b"); _setup(hc, "fof_c")
    _friends(ha, hb, "fof_b", "fof_a")
    _friends(hb, hc, "fof_c", "fof_b")
    suggested = client.get("/crew", headers=ha).json()["suggested"]
    assert [(p["username"], p["mutual"]) for p in suggested] == [("fof_c", 1)]


# ---------------------------------------------------------------------------
# holds
# ---------------------------------------------------------------------------

def test_holds_pay_once_per_reason_and_ref():
    uid, h = _login("crew-holds@example.com")
    _setup(h, "holds_once")
    db = SessionLocal()
    assert holds.award(db, uid, "solved", "same-question", 3) == 3
    assert holds.award(db, uid, "solved", "same-question", 3) == 0
    db.commit(); db.close()
    me = client.get("/crew", headers=h).json()["me"]
    assert me["holds_total"] == 3 and me["holds_week"] == 3 and me["streak"] == 1


def test_a_task_done_on_time_pays_once_however_often_it_is_ticked():
    uid, h = _login("crew-task@example.com")
    task = client.post("/tasks", json={"text": "Read chapter 3", "deadline": date.today().isoformat()}, headers=h).json()
    for done in (True, False, True):
        client.patch(f"/tasks/{task['id']}", json={"done": done}, headers=h)
    db = SessionLocal()
    rows = db.query(HoldEntry).filter(HoldEntry.user_id == uid, HoldEntry.reason == "on_time").all()
    db.close()
    assert [r.amount for r in rows] == [holds.ON_TIME]


def test_a_late_task_pays_nothing():
    uid, h = _login("crew-late@example.com")
    task = client.post("/tasks", json={"text": "Late one", "deadline": (date.today() - timedelta(days=2)).isoformat()},
                       headers=h).json()
    client.patch(f"/tasks/{task['id']}", json={"done": True}, headers=h)
    db = SessionLocal()
    assert db.query(HoldEntry).filter(HoldEntry.user_id == uid).count() == 0
    db.close()


def test_focus_pays_a_hold_per_quarter_hour_capped_per_day():
    uid, h = _login("crew-focus@example.com")
    rate_limit._hits.clear()
    client.post("/focus", json={"duration_seconds": 50 * 60}, headers=h)       # 3 quarters
    client.post("/focus", json={"duration_seconds": 3 * 3600}, headers=h)      # 12, capped
    db = SessionLocal()
    focus = sum(r.amount for r in db.query(HoldEntry).filter(HoldEntry.user_id == uid, HoldEntry.reason == "focus"))
    db.close()
    assert focus == holds.FOCUS_DAILY_CAP


def test_breaks_pay_twice_a_day_at_most():
    uid, h = _login("crew-break@example.com")
    got = [client.post("/crew/break", headers=h).json()["holds"] for _ in range(4)]
    assert got == [1, 1, 0, 0]


def test_a_solved_question_pays_three_holds(monkeypatch):
    uid, h = _login("crew-solved@example.com")
    rate_limit._hits.clear()

    class _Block:
        type = "text"
        text = "Exactly — you got it.\n```climby-solved\n```"

    class _Resp:
        content = [_Block()]
        usage = None

    monkeypatch.setattr(server.client.beta.messages, "create", lambda **kw: _Resp())
    res = client.post("/ask", json={"images": [], "question": "Is it 56?", "lang": "en", "surface": "chat"}, headers=h)
    assert res.status_code == 200
    assert res.json()["solved"] is True
    db = SessionLocal()
    assert db.query(HoldEntry).filter(HoldEntry.user_id == uid, HoldEntry.reason == "solved").count() == 1
    db.close()


def test_cheering_a_friend_gives_them_a_hold_once_a_day():
    _, ha = _login("crew-cha@example.com")
    _, hb = _login("crew-chb@example.com")
    _, hc = _login("crew-chc@example.com")
    _setup(ha, "cheer_a"); _setup(hb, "cheer_b"); _setup(hc, "cheer_c")
    _friends(ha, hb, "cheer_b", "cheer_a")
    assert client.post("/crew/cheer", json={"username": "cheer_b"}, headers=ha).status_code == 200
    assert client.post("/crew/cheer", json={"username": "cheer_b"}, headers=ha).status_code == 409
    assert client.post("/crew/cheer", json={"username": "cheer_b"}, headers=hc).status_code == 403   # not friends
    assert client.get("/crew", headers=hb).json()["me"]["holds_total"] == 1
    # a cheer is a gift: it keeps nobody's streak alive
    assert client.get("/crew", headers=hb).json()["me"]["streak"] == 0


def test_a_streak_day_pays_one_more():
    uid, h = _login("crew-streak@example.com")
    _setup(h, "streak_one")
    db = SessionLocal()
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)
    db.add(HoldEntry(user_id=uid, amount=3, reason="solved", ref="old", created_at=yesterday))
    db.commit()
    holds.award(db, uid, "solved", "new", 3)
    db.commit(); db.close()
    me = client.get("/crew", headers=h).json()["me"]
    assert me["streak"] == 2
    assert me["holds_total"] == 3 + 3 + holds.STREAK_DAY


# ---------------------------------------------------------------------------
# live, the photo, the account
# ---------------------------------------------------------------------------

def test_a_running_focus_session_shows_live_to_friends():
    _, ha = _login("crew-la@example.com")
    _, hb = _login("crew-lb@example.com")
    _setup(ha, "live_a"); _setup(hb, "live_b")
    _friends(ha, hb, "live_b", "live_a")
    client.post("/crew/live", json={"on": True}, headers=ha)
    friend = client.get("/crew", headers=hb).json()["friends"][0]
    assert friend["live"] is True and friend["live_minutes"] >= 1
    client.post("/crew/live", json={"on": False}, headers=ha)
    assert client.get("/crew", headers=hb).json()["friends"][0]["live"] is False


def test_live_runs_out_without_a_heartbeat():
    uid, h = _login("crew-lo@example.com")
    _setup(h, "live_out")
    db = SessionLocal()
    p = db.get(SocialProfile, uid)
    p.live_since = datetime.now(timezone.utc) - timedelta(minutes=30)
    p.live_until = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit(); db.close()
    assert client.get("/crew", headers=h).json()["me"]["live"] is False


def test_the_photo_must_be_a_small_picture():
    _, h = _login("crew-photo@example.com")
    _setup(h, "photo_one")
    assert client.post("/crew/avatar", json={"data": TINY_JPEG}, headers=h).status_code == 200
    assert client.get("/crew", headers=h).json()["me"]["avatar"] == TINY_JPEG
    assert client.post("/crew/avatar", json={"data": "data:image/jpeg;base64,aGVsbG8="}, headers=h).status_code == 400
    assert client.post("/crew/avatar", json={"data": "javascript:alert(1)"}, headers=h).status_code == 400
    assert client.delete("/crew/avatar", headers=h).status_code == 200
    assert client.get("/crew", headers=h).json()["me"]["avatar"] is None


def test_deleting_an_account_removes_its_crew_and_keeps_the_others_working():
    a, ha = _login("crew-del-a@example.com")
    _, hb = _login("crew-del-b@example.com")
    parent, hp = _login("crew-del-parent@example.com", role="parent")
    _setup(ha, "del_a"); _setup(hb, "del_b")
    _friends(ha, hb, "del_b", "del_a")
    client.post("/crew/cheer", json={"username": "del_b"}, headers=ha)
    # a parent who approved a child, then leaves
    kid, hk = _login("crew-del-kid@example.com")
    _setup(hk, "del_kid", age=crew.PARENT_APPROVAL_UNDER - 1)
    db = SessionLocal()
    db.add(FamilyLink(parent_user_id=parent, student_user_id=kid))
    db.commit(); db.close()
    client.post("/crew/approvals", json={"student_id": kid, "allow": True}, headers=hp)

    export = client.get("/account/export", headers=ha).json()["crew"]
    assert export["set_up"] is True and export["friends"] == ["Crew-Del-B"]

    assert client.request("DELETE", "/account", json={"password": "testpass123"}, headers=ha).status_code == 200
    assert client.request("DELETE", "/account", json={"password": "testpass123"}, headers=hp).status_code == 200
    db = SessionLocal()
    assert db.get(SocialProfile, a) is None
    assert db.query(HoldEntry).filter(HoldEntry.user_id == a).count() == 0
    assert db.get(SocialProfile, kid).parent_approved_by is None
    db.close()
    assert client.get("/crew", headers=hb).json()["friends"] == []
    assert client.get("/crew", headers=hb).json()["me"]["holds_total"] == 1     # the cheer they got stays theirs
    assert client.get("/crew", headers=hk).json()["needs"] == "parent"
