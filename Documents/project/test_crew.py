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
    client.post("/auth/register", json={"accept_terms": True, 
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


def test_approval_needs_a_parent_with_a_verified_phone_even_after_linking():
    kid, hk = _login("crew-kid5@example.com")
    parent, hp = _login("crew-kid5-parent@example.com", role="parent")
    _setup(hk, "little_five", age=crew.PARENT_APPROVAL_UNDER - 1)
    db = SessionLocal()
    db.add(FamilyLink(parent_user_id=parent, student_user_id=kid))
    db.query(User).filter(User.id == parent).update({User.role: "student"})
    db.commit(); db.close()
    res = client.post("/crew/approvals", json={"student_id": kid, "allow": True}, headers=hp)
    assert res.status_code == 403 and res.json()["detail"] == {"needs": "parent"}

    db = SessionLocal()
    db.query(User).filter(User.id == parent).update({User.role: "parent", User.is_phone_verified: False})
    db.commit(); db.close()
    res = client.post("/crew/approvals", json={"student_id": kid, "allow": True}, headers=hp)
    assert res.status_code == 403 and res.json()["detail"] == {"needs": "phone"}
    assert client.get("/crew", headers=hk).json()["needs"] == "parent"


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
    _backdate_user(uid, hours=6)
    client.post("/focus", json={"duration_seconds": 50 * 60}, headers=h)       # 3 quarters
    _backdate_sessions(uid, hours=4)
    client.post("/focus", json={"duration_seconds": 3 * 3600}, headers=h)      # 12, capped
    db = SessionLocal()
    focus = sum(r.amount for r in db.query(HoldEntry).filter(HoldEntry.user_id == uid, HoldEntry.reason == "focus"))
    db.close()
    assert focus == holds.FOCUS_DAILY_CAP



def _backdate_user(uid, hours):
    db = SessionLocal()
    db.query(User).filter(User.id == uid).update(
        {User.created_at: datetime.now(timezone.utc) - timedelta(hours=hours)})
    db.commit(); db.close()


def _backdate_sessions(uid, hours):
    db = SessionLocal()
    db.query(FocusSession).filter(FocusSession.user_id == uid).update(
        {FocusSession.created_at: datetime.now(timezone.utc) - timedelta(hours=hours)})
    db.commit(); db.close()


def test_a_focus_session_cannot_be_longer_than_the_time_that_passed():
    """The length comes from the app; the server pays only for time it saw pass."""
    uid, h = _login("crew-focus-fake@example.com")
    rate_limit._hits.clear()
    _backdate_user(uid, hours=1)
    client.post("/focus", json={"duration_seconds": 24 * 3600}, headers=h)     # an hour has passed: 4 quarters at most
    client.post("/focus", json={"duration_seconds": 24 * 3600}, headers=h)     # and none since the last one
    db = SessionLocal()
    focus = sum(r.amount for r in db.query(HoldEntry).filter(HoldEntry.user_id == uid, HoldEntry.reason == "focus"))
    db.close()
    assert focus == 12 * holds.FOCUS_PER_5_MIN


def test_cheers_pay_only_so_much_a_day_in_total():
    uid, _ = _login("crew-cheered@example.com")
    db = SessionLocal()
    got = sum(holds.on_cheer(db, f"fan-{i}", uid) for i in range(holds.CHEERS_DAILY_CAP // holds.CHEER + 5))
    db.commit(); db.close()
    assert got == holds.CHEERS_DAILY_CAP

def test_breaks_pay_twice_a_day_at_most():
    uid, h = _login("crew-break@example.com")
    got = [client.post("/crew/break", headers=h).json()["holds"] for _ in range(4)]
    assert got == [holds.BREAK, holds.BREAK, 0, 0]


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
    assert client.get("/crew", headers=hb).json()["me"]["holds_total"] == holds.CHEER
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
    assert client.get("/crew", headers=hb).json()["me"]["holds_total"] == holds.CHEER     # the cheer they got stays theirs
    assert client.get("/crew", headers=hk).json()["needs"] == "parent"


# ---------------------------------------------------------------------------
# from the code review, 2026-10-18
# ---------------------------------------------------------------------------

def _boom(*a, **k):
    raise RuntimeError("holds are down")


def test_a_failing_hold_never_costs_the_tick(monkeypatch):
    _, h = _login("crew-r-tick@example.com")
    task = client.post("/tasks", json={"text": "Tick me"}, headers=h).json()
    monkeypatch.setattr(holds, "on_task_done", _boom)
    res = client.patch(f"/tasks/{task['id']}", json={"done": True}, headers=h)
    assert res.status_code == 200 and res.json()["done"] is True


def test_a_failing_hold_never_costs_the_focus_session(monkeypatch):
    uid, h = _login("crew-r-focus@example.com")
    rate_limit._hits.clear()
    monkeypatch.setattr(holds, "on_focus", _boom)
    assert client.post("/focus", json={"duration_seconds": 1800}, headers=h).status_code == 200
    db = SessionLocal()
    assert db.query(FocusSession).filter(FocusSession.user_id == uid).count() == 1
    db.close()


def test_a_failing_hold_never_costs_the_question(monkeypatch):
    from models import ScanHistory
    uid, h = _login("crew-r-solved@example.com")
    rate_limit._hits.clear()

    class _Block:
        type = "text"
        text = "Right.\n```climby-solved\n```"

    class _Resp:
        content = [_Block()]
        usage = None

    monkeypatch.setattr(server.client.beta.messages, "create", lambda **kw: _Resp())
    monkeypatch.setattr(holds, "on_solved", _boom)
    assert client.post("/ask", json={"images": [], "question": "q", "lang": "en", "surface": "chat"}, headers=h).status_code == 200
    db = SessionLocal()
    assert db.query(ScanHistory).filter(ScanHistory.user_id == uid).count() == 1
    db.close()


def test_solved_holds_are_capped_per_day():
    uid, _ = _login("crew-r-cap@example.com")
    db = SessionLocal()
    for i in range(20):
        holds.on_solved(db, uid, f"scan-{i}")
    db.commit()
    total = sum(e.amount for e in db.query(HoldEntry).filter(HoldEntry.user_id == uid))
    db.close()
    assert total == holds.SOLVED_DAILY_CAP


def test_search_is_not_crowded_out_by_accounts_outside_crew():
    _, ha = _login("crew-r-seeker@example.com")
    _setup(ha, "seeker_r")
    db = SessionLocal()
    for i in range(30):
        db.add(User(display_name="X", email=f"crowd{i}@example.com", username=f"crowd{i:02d}",
                    password_hash="x", is_email_verified=True, is_phone_verified=False))
    db.commit(); db.close()
    _, hc = _login("crew-r-real@example.com")
    _setup(hc, "crowd_real_one")
    assert [p["username"] for p in client.get("/crew/search?q=crowd", headers=ha).json()] == ["crowd_real_one"]


def test_block_does_not_say_whether_a_username_exists():
    _, h = _login("crew-r-block@example.com")
    _setup(h, "blocker_r")
    _, hx = _login("crew-r-outside@example.com")
    db = SessionLocal()
    db.query(User).filter(User.email == "crew-r-outside@example.com").update({User.username: "outside_x"})
    db.commit(); db.close()
    for name in ("outside_x", "nobody_at_all_x"):
        assert client.post("/crew/block", json={"username": name}, headers=h).json() == {"status": "ok"}
    # and someone not in Crew cannot use it at all
    assert client.post("/crew/block", json={"username": "blocker_r"}, headers=hx).status_code == 403


def test_crew_never_changes_the_username_you_sign_in_with():
    _, h = _login("crew-r-login@example.com")
    db = SessionLocal()
    db.query(User).filter(User.email == "crew-r-login@example.com").update({User.username: "Ivan2012"})
    db.commit(); db.close()
    assert _setup(h, "ivan.climbs").status_code == 409
    res = _setup(h, "ivan2012")
    assert res.status_code == 200 and res.json()["me"]["username"] == "Ivan2012"


def test_a_long_streak_is_counted_in_full():
    uid, h = _login("crew-r-streak@example.com")
    _setup(h, "streak_long")
    db = SessionLocal()
    now = datetime.now(timezone.utc)
    for d in range(90):
        db.add(HoldEntry(user_id=uid, amount=1, reason="break", ref=f"d{d}", created_at=now - timedelta(days=d)))
    db.commit(); db.close()
    assert client.get("/crew", headers=h).json()["me"]["streak"] == 90


def test_linking_again_does_not_bring_back_an_old_yes():
    kid, hk = _login("crew-r-kid@example.com")
    parent, hp = _login("crew-r-parent@example.com", role="parent")
    _setup(hk, "relink_kid", age=crew.PARENT_APPROVAL_UNDER - 2)
    db = SessionLocal()
    db.add(FamilyLink(parent_user_id=parent, student_user_id=kid))
    db.commit(); db.close()
    client.post("/crew/approvals", json={"student_id": kid, "allow": True}, headers=hp)
    assert client.get("/crew", headers=hk).json()["needs"] is None
    assert client.delete(f"/family/students/{kid}", headers=hp).status_code == 200
    db = SessionLocal()
    db.add(FamilyLink(parent_user_id=parent, student_user_id=kid))
    db.commit(); db.close()
    assert client.get("/crew", headers=hk).json()["needs"] == "parent"


def test_the_friend_limit_holds_on_accept_too(monkeypatch):
    _, ha = _login("crew-r-la@example.com")
    _, hb = _login("crew-r-lb@example.com")
    _, hc = _login("crew-r-lc@example.com")
    _setup(ha, "limit_a"); _setup(hb, "limit_b"); _setup(hc, "limit_c")
    _friends(ha, hb, "limit_b", "limit_a")
    client.post("/crew/requests", json={"username": "limit_a"}, headers=hc)
    monkeypatch.setattr(crew, "MAX_FRIENDS", 1)
    assert client.post("/crew/requests/accept", json={"username": "limit_c"}, headers=ha).status_code == 409


def test_strangers_see_no_photo_no_holds_no_live():
    sa, ha = _login("crew-r-sa@example.com")
    _, hb = _login("crew-r-sb@example.com")
    _setup(ha, "stranger_a"); _setup(hb, "stranger_b")
    client.post("/crew/avatar", json={"data": TINY_JPEG}, headers=ha)
    client.post("/crew/live", json={"on": True}, headers=ha)
    db = SessionLocal()
    holds.award(db, sa, "solved", "s1", 3)
    db.commit(); db.close()
    client.post("/crew/requests", json={"username": "stranger_b"}, headers=ha)
    seen = client.get("/crew", headers=hb).json()["incoming"][0]
    assert seen["avatar"] is None and seen["holds_total"] == 0 and seen["live"] is False
    found = client.get("/crew/search?q=stranger_a", headers=hb).json()[0]
    assert found["avatar"] is None and found["holds_total"] == 0


def test_the_counter_endpoint_counts_without_crew():
    uid, h = _login("crew-r-counter@example.com")
    db = SessionLocal()
    holds.on_solved(db, uid, "q-counter")
    db.commit(); db.close()
    assert client.get("/crew/holds", headers=h).json() == {"total": holds.SOLVED, "week": holds.SOLVED}
