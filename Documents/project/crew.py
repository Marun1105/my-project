# crew.py — Crew: friends on one mountain, and the holds that put them there.
#
# The rules the owner chose (docs/plan-2026-10-social.md):
#   - Crew is for students. It is set up once: month and year of birth (the
#     age rules need an age, not a grade) and a username to be found by.
#   - Under PARENT_APPROVAL_UNDER, it opens only after a linked parent allows
#     it from their own account. The approval lasts as long as that link.
#   - Everyone can be found by username; friends only when both say yes.
#   - A block is total: neither sees the other in search, Crew or requests.
#   - Friends see each other's photo, grade, holds, streak and whether a focus
#     session is running — never tasks, questions or anything else.
import base64
import binascii
import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import holds
from family import require_real_parent
import rate_limit
from auth import get_current_user
from db import get_db
from models import Block, FamilyLink, FriendRequest, Friendship, SocialProfile, User
from schemas import image_media_type

router = APIRouter(prefix="/crew", tags=["crew"])


def _commit(db: Session) -> None:
    """Commit; a double click that raced itself into a unique constraint is
    not an error — the first click already did what the second asked for."""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()

# Bulgaria's age of digital consent is 14 (GDPR art. 8), so below it Crew
# needs a parent. Raised from the owner's first choice of 12 on 2026-10-29.
PARENT_APPROVAL_UNDER = 14
MIN_AGE, MAX_AGE = 6, 20
LIVE_FOR = timedelta(minutes=3)          # one missed heartbeat is not the end of a session
MAX_AVATAR_BYTES = 120_000               # the editor saves 256 px JPEG, about 20 KB
USERNAME = re.compile(r"^[a-z0-9](?:[a-z0-9._]{1,18})[a-z0-9]$")
RESERVED = {"admin", "climby", "climbai", "support", "help", "moderator", "official", "system"}
MAX_FRIENDS = 200


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def age_of(profile: SocialProfile, today: Optional[date] = None) -> int:
    today = today or date.today()
    return today.year - profile.birth_year - (1 if today.month < profile.birth_month else 0)


def _approved(db: Session, profile: SocialProfile) -> bool:
    """A parent's yes counts only while that parent is still linked."""
    if not profile.parent_approved_at or not profile.parent_approved_by:
        return False
    return db.query(FamilyLink.id).filter(
        FamilyLink.parent_user_id == profile.parent_approved_by,
        FamilyLink.student_user_id == profile.user_id).first() is not None


def state(db: Session, user: User, profile: Optional[SocialProfile] = None) -> str:
    """'role' | 'setup' | 'parent' | 'ok' — what this account may do in Crew."""
    if (user.role or "student") != "student":
        return "role"
    profile = profile if profile is not None else db.get(SocialProfile, user.id)
    if profile is None or not user.username:
        return "setup"
    if age_of(profile) < PARENT_APPROVAL_UNDER and not _approved(db, profile):
        return "parent"
    return "ok"


def _blocked_ids(db: Session, uid: str) -> set:
    rows = db.query(Block.blocker_id, Block.blocked_id).filter(
        or_(Block.blocker_id == uid, Block.blocked_id == uid)).all()
    return {b if a == uid else a for a, b in rows}


def _friend_ids(db: Session, uid: str) -> set:
    rows = db.query(Friendship.user_a, Friendship.user_b).filter(
        or_(Friendship.user_a == uid, Friendship.user_b == uid)).all()
    return {b if a == uid else a for a, b in rows}


def _pair(a: str, b: str):
    return (a, b) if a < b else (b, a)


def _visible(db: Session, ids) -> dict:
    """{id: (user, profile)} for the accounts that are set up and allowed in Crew."""
    ids = list(set(ids))
    if not ids:
        return {}
    users = {u.id: u for u in db.query(User).filter(User.id.in_(ids))}
    profiles = {p.user_id: p for p in db.query(SocialProfile).filter(SocialProfile.user_id.in_(ids))}
    out = {}
    for uid, u in users.items():
        p = profiles.get(uid)
        if p is not None and state(db, u, p) == "ok":
            out[uid] = (u, p)
    return out


def _by_username(db: Session, me: User, username: str) -> User:
    name = (username or "").strip().lstrip("@").lower()
    other = db.query(User).filter(func.lower(User.username) == name).first() if name else None
    # One answer for "nobody", "blocked" and "not in Crew": none of them is
    # anyone's business, and different answers would say which it was.
    if (other is None or other.id == me.id or other.id in _blocked_ids(db, me.id)
            or other.id not in _visible(db, [other.id])):
        raise HTTPException(404, "Nobody with that username.")
    return other


def _person(u: User, p: SocialProfile, h: dict, mutual: int = 0) -> dict:
    now = _now()
    live_until = _as_utc(p.live_until)
    live = bool(live_until and live_until > now)
    since = _as_utc(p.live_since)
    return {
        "username": u.username,
        "name": u.display_name,
        "grade": u.grade,
        "avatar": p.avatar,
        "holds_week": h.get("week", 0),
        "holds_total": h.get("total", 0),
        "streak": h.get("streak", 0),
        "live": live,
        "live_minutes": max(1, int((now - since).total_seconds() // 60)) if live and since else 0,
        "mutual": mutual,
    }


def _stranger(u: User, mutual: int = 0) -> dict:
    """Someone who is not (yet) a friend: who they are, never how they are
    doing, and no photo — the photo is for friends."""
    return {
        "username": u.username, "name": u.display_name, "grade": u.grade, "avatar": None,
        "holds_week": 0, "holds_total": 0, "streak": 0, "live": False, "live_minutes": 0,
        "mutual": mutual,
    }


def _friend_map(db: Session, ids) -> dict:
    """{id: set of friend ids} for many people in one query."""
    ids = list({i for i in ids if i})
    out = {i: set() for i in ids}
    if not ids:
        return out
    for a, b in db.query(Friendship.user_a, Friendship.user_b).filter(
            or_(Friendship.user_a.in_(ids), Friendship.user_b.in_(ids))):
        if a in out:
            out[a].add(b)
        if b in out:
            out[b].add(a)
    return out


def _me(db: Session, user: User) -> SocialProfile:
    """The caller's own profile, or 403 with the state that is missing."""
    profile = db.get(SocialProfile, user.id)
    s = state(db, user, profile)
    if s != "ok":
        raise HTTPException(403, {"needs": s})
    return profile


# ---------------------------------------------------------------------------
# the mountain
# ---------------------------------------------------------------------------

@router.get("")
def crew(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.get(SocialProfile, user.id)
    s = state(db, user, profile)
    if s != "ok":
        out = {"needs": s, "username": user.username, "grade": user.grade}
        if s == "parent":
            out["has_parent"] = db.query(FamilyLink.id).filter(FamilyLink.student_user_id == user.id).first() is not None
        return out

    blocked = _blocked_ids(db, user.id)
    friend_ids = _friend_ids(db, user.id) - blocked
    friends = _visible(db, friend_ids)

    # friends of friends: who to add next, by how many friends you share
    fof = {}
    if friend_ids:
        for a, b in db.query(Friendship.user_a, Friendship.user_b).filter(
                or_(Friendship.user_a.in_(list(friend_ids)), Friendship.user_b.in_(list(friend_ids)))):
            for x, y in ((a, b), (b, a)):
                if x in friend_ids and y != user.id and y not in friend_ids and y not in blocked:
                    fof[y] = fof.get(y, 0) + 1
    incoming_ids = [r.from_user_id for r in db.query(FriendRequest).filter(FriendRequest.to_user_id == user.id)]
    outgoing_ids = {r.to_user_id for r in db.query(FriendRequest).filter(FriendRequest.from_user_id == user.id)}
    suggested_ids = [i for i, _ in sorted(fof.items(), key=lambda kv: -kv[1])
                     if i not in outgoing_ids and i not in incoming_ids][:12]
    others = _visible(db, [i for i in incoming_ids if i not in blocked] + suggested_ids)

    # numbers only for friends and yourself
    h = holds.totals(db, [user.id, *friends.keys()])
    their_friends = _friend_map(db, [*friends.keys(), *others.keys()])

    def mutual(uid: str) -> int:
        return len(their_friends.get(uid, set()) & friend_ids)

    me = _person(user, profile, h.get(user.id, {}))
    return {
        "needs": None,
        "me": me,
        "friends": [_person(u, p, h.get(uid, {}), mutual(uid)) for uid, (u, p) in friends.items()],
        "incoming": [_stranger(others[i][0], mutual(i)) for i in incoming_ids if i in others],
        "outgoing": [u.username for u in db.query(User).filter(User.id.in_(list(outgoing_ids)))] if outgoing_ids else [],
        "suggested": [_stranger(others[i][0], fof.get(i, 0)) for i in suggested_ids if i in others][:6],
        "groups": [],
    }


@router.get("/holds")
def my_holds(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Just the numbers, for the counter in the menu: cheap enough to ask after
    every tick, answer and session. Holds are earned whether or not Crew is set up."""
    h = holds.totals(db, [user.id]).get(user.id, {})
    return {"total": h.get("total", 0), "week": h.get("week", 0)}


# ---------------------------------------------------------------------------
# setting up
# ---------------------------------------------------------------------------

class ProfileIn(BaseModel):
    birth_year: int = Field(ge=1990, le=2100)
    birth_month: int = Field(ge=1, le=12)
    username: str = Field(min_length=3, max_length=20)


@router.post("/profile")
def set_up(body: ProfileIn, request: Request,
           user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-profile", max_calls=20, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.", user=user)
    if (user.role or "student") != "student":
        raise HTTPException(403, {"needs": "role"})
    name = body.username.strip().lstrip("@").lower()
    # The username is also what some students sign in with: Crew uses the one
    # the account has and never changes it.
    if user.username:
        if name != user.username.lower():
            raise HTTPException(409, f"Your username is @{user.username} — Crew uses that one.")
        name = user.username
    elif not USERNAME.match(name) or ".." in name or name in RESERVED:
        raise HTTPException(400, "Use 3–20 letters, numbers, dots or underscores, starting and ending with a letter or number.")
    taken = db.query(User.id).filter(func.lower(User.username) == name.lower(), User.id != user.id).first()
    if taken:
        raise HTTPException(409, "That username is taken.")

    profile = db.get(SocialProfile, user.id)
    if profile is None:
        candidate = SocialProfile(user_id=user.id, birth_year=body.birth_year, birth_month=body.birth_month)
        if not MIN_AGE <= age_of(candidate) <= MAX_AGE:
            raise HTTPException(400, "Check the year of birth.")
        db.add(candidate)
        profile = candidate
    elif (profile.birth_year, profile.birth_month) != (body.birth_year, body.birth_month):
        # Set once. Otherwise the age rules are one click from meaning nothing.
        raise HTTPException(409, "The date of birth is already set. To correct it, write to support.")

    user.username = name
    try:
        db.commit()
    except IntegrityError:
        # the same username taken a moment ago, or a double click
        db.rollback()
        db.refresh(user)
        if (user.username or "").lower() != name.lower():
            raise HTTPException(409, "That username is taken.")
    return crew(user=user, db=db)


class AvatarIn(BaseModel):
    data: str = Field(max_length=200_000)


@router.post("/avatar")
def set_avatar(body: AvatarIn, request: Request,
               user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-avatar", max_calls=30, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.", user=user)
    profile = db.get(SocialProfile, user.id)
    if profile is None:
        raise HTTPException(403, {"needs": "setup"})
    m = re.match(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$", body.data or "")
    if not m:
        raise HTTPException(400, "That is not a picture.")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "That is not a picture.")
    if len(raw) > MAX_AVATAR_BYTES or image_media_type(m.group(2)) != m.group(1):
        raise HTTPException(400, "That is not a picture, or it is too big.")
    profile.avatar = body.data
    db.commit()
    return {"status": "ok"}


@router.delete("/avatar")
def remove_avatar(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-avatar", max_calls=30, window_seconds=3600,
                       message="That's a lot of changes at once. Please wait a moment.", user=user)
    profile = db.get(SocialProfile, user.id)
    if profile is not None:
        profile.avatar = None
        db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# finding people and becoming friends
# ---------------------------------------------------------------------------

@router.get("/search")
def search(q: str, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-search", max_calls=120, window_seconds=3600,
                       message="Too many searches. Please wait a moment.", user=user)
    _me(db, user)
    name = q.strip().lstrip("@").lower()
    if len(name) < 3 or not re.match(r"^[a-z0-9._]+$", name):
        return []
    like = name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    hits = (db.query(User.id)
            .join(SocialProfile, SocialProfile.user_id == User.id)
            .filter(func.lower(User.username).like(like, escape="\\"), User.id != user.id,
                    func.coalesce(User.role, "student") == "student")
            .order_by(func.length(User.username)).limit(40).all())
    blocked = _blocked_ids(db, user.id)
    friends = _friend_ids(db, user.id)
    found = _visible(db, [i for (i,) in hits if i not in blocked and i not in friends])
    outgoing = {r.to_user_id for r in db.query(FriendRequest).filter(FriendRequest.from_user_id == user.id)}
    incoming = {r.from_user_id for r in db.query(FriendRequest).filter(FriendRequest.to_user_id == user.id)}
    their_friends = _friend_map(db, found.keys())
    out = []
    for uid, (u, p) in sorted(found.items(), key=lambda kv: len(kv[1][0].username or "")):
        person = _stranger(u, len(their_friends.get(uid, set()) & friends))
        person["request"] = "sent" if uid in outgoing else "incoming" if uid in incoming else None
        out.append(person)
    return out[:8]


class UsernameIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)


def _room_for_friends(db: Session, *ids) -> None:
    for uid in ids:
        if len(_friend_ids(db, uid)) >= MAX_FRIENDS:
            raise HTTPException(409, "That is a lot of friends already.")


def _befriend(db: Session, a: str, b: str) -> None:
    x, y = _pair(a, b)
    if not db.query(Friendship.id).filter(Friendship.user_a == x, Friendship.user_b == y).first():
        db.add(Friendship(user_a=x, user_b=y))
    db.query(FriendRequest).filter(or_(
        (FriendRequest.from_user_id == a) & (FriendRequest.to_user_id == b),
        (FriendRequest.from_user_id == b) & (FriendRequest.to_user_id == a))).delete(synchronize_session=False)


@router.post("/requests")
def send_request(body: UsernameIn, request: Request,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-request", max_calls=40, window_seconds=3600,
                       message="Too many requests. Please wait a moment.", user=user)
    _me(db, user)
    other = _by_username(db, user, body.username)
    if other.id in _friend_ids(db, user.id):
        return {"status": "friends"}
    _room_for_friends(db, user.id)
    # They asked first: saying it back is saying yes.
    if db.query(FriendRequest.id).filter(FriendRequest.from_user_id == other.id,
                                         FriendRequest.to_user_id == user.id).first():
        _room_for_friends(db, other.id)
        _befriend(db, user.id, other.id)
        _commit(db)
        return {"status": "friends"}
    if not db.query(FriendRequest.id).filter(FriendRequest.from_user_id == user.id,
                                             FriendRequest.to_user_id == other.id).first():
        db.add(FriendRequest(from_user_id=user.id, to_user_id=other.id))
        _commit(db)
    return {"status": "sent"}


@router.post("/requests/accept")
def accept(body: UsernameIn, request: Request, user: User = Depends(get_current_user),
           db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-answer", max_calls=60, window_seconds=3600,
                       message="That's a lot of changes at once. Please wait a moment.", user=user)
    _me(db, user)
    other = _by_username(db, user, body.username)
    if not db.query(FriendRequest.id).filter(FriendRequest.from_user_id == other.id,
                                             FriendRequest.to_user_id == user.id).first():
        raise HTTPException(404, "No request from that person.")
    _room_for_friends(db, user.id, other.id)
    _befriend(db, user.id, other.id)
    _commit(db)
    return {"status": "friends"}


@router.post("/requests/decline")
def decline(body: UsernameIn, request: Request, user: User = Depends(get_current_user),
            db: Session = Depends(get_db)):
    """Declines theirs, or takes back mine. Says nothing to the other person."""
    rate_limit.enforce(request, "crew-answer", max_calls=60, window_seconds=3600,
                       message="That's a lot of changes at once. Please wait a moment.", user=user)
    _me(db, user)
    name = body.username.strip().lstrip("@").lower()
    other = db.query(User).filter(func.lower(User.username) == name).first()
    if other is not None:
        db.query(FriendRequest).filter(or_(
            (FriendRequest.from_user_id == other.id) & (FriendRequest.to_user_id == user.id),
            (FriendRequest.from_user_id == user.id) & (FriendRequest.to_user_id == other.id),
        )).delete(synchronize_session=False)
        db.commit()
    return {"status": "ok"}


@router.post("/unfriend")
def unfriend(body: UsernameIn, request: Request, user: User = Depends(get_current_user),
             db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-unfriend", max_calls=30, window_seconds=3600,
                       message="That's a lot of changes at once. Please wait a moment.", user=user)
    _me(db, user)
    name = body.username.strip().lstrip("@").lower()
    other = db.query(User).filter(func.lower(User.username) == name).first()
    if other is not None:
        x, y = _pair(user.id, other.id)
        db.query(Friendship).filter(Friendship.user_a == x, Friendship.user_b == y).delete(synchronize_session=False)
        db.commit()
    return {"status": "ok"}


@router.post("/block")
def block(body: UsernameIn, request: Request,
          user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Total and silent: the friendship and any request go, and neither of you
    finds the other again. The other person is not told."""
    rate_limit.enforce(request, "crew-block", max_calls=30, window_seconds=3600,
                       message="Too many attempts. Please wait a moment.", user=user)
    _me(db, user)
    name = body.username.strip().lstrip("@").lower()
    other = db.query(User).filter(func.lower(User.username) == name).first()
    # The same answer whether the name exists or not: this must not become a
    # way to test which usernames are real. Only people in Crew can be blocked.
    if other is None or other.id == user.id or db.get(SocialProfile, other.id) is None:
        return {"status": "ok"}
    if not db.query(Block.id).filter(Block.blocker_id == user.id, Block.blocked_id == other.id).first():
        db.add(Block(blocker_id=user.id, blocked_id=other.id))
    x, y = _pair(user.id, other.id)
    db.query(Friendship).filter(Friendship.user_a == x, Friendship.user_b == y).delete(synchronize_session=False)
    db.query(FriendRequest).filter(or_(
        (FriendRequest.from_user_id == other.id) & (FriendRequest.to_user_id == user.id),
        (FriendRequest.from_user_id == user.id) & (FriendRequest.to_user_id == other.id),
    )).delete(synchronize_session=False)
    _commit(db)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# cheering, live, breaks
# ---------------------------------------------------------------------------

@router.post("/cheer")
def cheer(body: UsernameIn, request: Request,
          user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-cheer", max_calls=60, window_seconds=3600,
                       message="Too many cheers. Please wait a moment.", user=user)
    _me(db, user)
    other = _by_username(db, user, body.username)
    if other.id not in _friend_ids(db, user.id):
        raise HTTPException(403, "You can cheer friends only.")
    given = holds.on_cheer(db, user.id, other.id)
    db.commit()
    if not given:
        raise HTTPException(409, "You already cheered them today.")
    return {"status": "ok", "holds": given}


class LiveIn(BaseModel):
    on: bool


@router.post("/live")
def live(body: LiveIn, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """A focus session running: sent at the start and then every minute."""
    rate_limit.enforce(request, "crew-live", max_calls=240, window_seconds=3600,
                       message="Too many updates.", user=user)
    profile = db.get(SocialProfile, user.id)
    if profile is None:
        return {"status": "ignored"}           # not in Crew: nobody to tell
    now = _now()
    if body.on:
        until = _as_utc(profile.live_until)
        if not until or until <= now:
            profile.live_since = now
        profile.live_until = now + LIVE_FOR
    else:
        profile.live_since = None
        profile.live_until = None
    db.commit()
    return {"status": "ok"}


@router.post("/break")
def took_break(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "crew-break", max_calls=20, window_seconds=3600,
                       message="Too many breaks.", user=user)
    given = holds.on_break(db, user.id)
    db.commit()
    return {"holds": given}


# ---------------------------------------------------------------------------
# the parent's side
# ---------------------------------------------------------------------------

@router.get("/approvals")
def approvals(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """For a parent: each linked child, and whether Crew waits for their yes."""
    links = db.query(FamilyLink).filter(FamilyLink.parent_user_id == user.id).all()
    out = []
    for link in links:
        profile = db.get(SocialProfile, link.student_user_id)
        if profile is None:
            continue
        young = age_of(profile) < PARENT_APPROVAL_UNDER
        out.append({
            "student_id": link.student_user_id,
            "needs_approval": young,
            "approved": young and _approved(db, profile),
        })
    return out


class ApprovalIn(BaseModel):
    student_id: str = Field(min_length=1, max_length=64)
    allow: bool


@router.post("/approvals")
def set_approval(body: ApprovalIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # checked again here, not only at linking: a role can be changed afterwards
    require_real_parent(user)
    linked = db.query(FamilyLink.id).filter(FamilyLink.parent_user_id == user.id,
                                            FamilyLink.student_user_id == body.student_id).first()
    profile = db.get(SocialProfile, body.student_id) if linked else None
    if profile is None:
        raise HTTPException(404, "No linked child with Crew set up.")
    if body.allow:
        profile.parent_approved_at = _now()
        profile.parent_approved_by = user.id
    else:
        profile.parent_approved_at = None
        profile.parent_approved_by = None
        profile.live_since = profile.live_until = None
    db.commit()
    return {"status": "ok", "approved": body.allow}
