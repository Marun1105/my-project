# -*- coding: utf-8 -*-
# social.py — приятелите и класациите.
#
# Цялото досие на този файл е едно изречение, взето от classes.py и несмекчено:
# съученикът вижда числа, никога съдържание. Затова тук няма нито един път, по
# който текст на задача, въпрос към ClimbAI, отговор или имейл да стигне до
# друг човек — не защото се филтрира, а защото никога не се чете.
#
# Приятелство се иска само с код. Търсене по име няма и няма да има: в Climby
# дете не може да бъде намерено от някой, който не го познава лично.
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import clibis
from auth import get_current_user
from db import get_db
from models import (
    ClassroomMember,
    ClibiLedger,
    FocusSession,
    Friendship,
    RopePartner,
    ScanHistory,
    SocialProfile,
    Task,
    User,
)

router = APIRouter(prefix="/social", tags=["social"])

# Същата азбука като класовете и родителските покани: кодът се диктува на глас
# в междучасието, затова без 0/O/1/I.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6
MAX_FRIENDS = 60
NICKNAME_MAX = 20


class NicknameIn(BaseModel):
    nickname: str = Field(max_length=NICKNAME_MAX)


# --------------------------------------------------------------------- профил


def _generate_code(db: Session) -> str:
    for _ in range(10):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if not db.query(SocialProfile).filter(SocialProfile.friend_code == code).first():
            return code
    raise HTTPException(500, "We could not generate a code. Please try again.")


def get_profile(db: Session, user_id: str) -> SocialProfile:
    """Редът се прави при първо четене, не при регистрация.

    Акаунтите отпреди този файл нямат такъв ред, а добавянето му със скрипт по
    всички тях е миграция, която не е нужна: кодът трябва да съществува в мига,
    в който някой го поиска, и нито миг по-рано.
    """
    row = db.query(SocialProfile).filter(SocialProfile.user_id == user_id).first()
    if row:
        return row
    row = SocialProfile(user_id=user_id, friend_code=_generate_code(db))
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Два едновременни прочита; другият е спечелил и редът вече съществува.
        db.rollback()
        row = db.query(SocialProfile).filter(SocialProfile.user_id == user_id).first()
    return row


def _stats(db: Session, user_id: str) -> dict:
    """Числата, и само числата."""
    solved = (db.query(func.count(ScanHistory.id))
              .filter(ScanHistory.user_id == user_id,
                      ScanHistory.solved_unaided.is_(True)).scalar() or 0)
    done = (db.query(func.count(Task.id))
            .filter(Task.user_id == user_id, Task.done.is_(True)).scalar() or 0)
    seconds = (db.query(func.coalesce(func.sum(FocusSession.duration_seconds), 0))
               .filter(FocusSession.user_id == user_id).scalar() or 0)
    return {
        "clibis": clibis.balance(db, user_id),
        "solved": int(solved),
        "tasks_done": int(done),
        "focus_minutes": int(seconds) // 60,
    }


@router.get("/me")
def my_profile(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = get_profile(db, user.id)
    return {
        "friend_code": row.friend_code,
        "nickname": row.nickname,
        "on_global_board": row.on_global_board,
        "name": user.display_name,
        "grade": user.grade,
        **_stats(db, user.id),
    }


@router.post("/global-board")
def join_global_board(body: NicknameIn,
                      user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """Прякор, за да стои в общия списък — и display_name никога не отива там."""
    nickname = (body.nickname or "").strip()
    if not nickname:
        raise HTTPException(400, "Pick a nickname first.")
    row = get_profile(db, user.id)
    row.nickname = nickname
    row.on_global_board = True
    db.commit()
    return {"nickname": nickname, "on_global_board": True}


@router.delete("/global-board")
def leave_global_board(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = get_profile(db, user.id)
    row.on_global_board = False
    db.commit()
    return {"on_global_board": False}


# ---------------------------------------------------------------- приятелства


def _pair(db: Session, a_id: str, b_id: str) -> Optional[Friendship]:
    return (db.query(Friendship)
            .filter(or_(
                (Friendship.requester_id == a_id) & (Friendship.addressee_id == b_id),
                (Friendship.requester_id == b_id) & (Friendship.addressee_id == a_id),
            ))
            .first())


def are_connected(db: Session, a_id: str, b_id: str) -> bool:
    """Приятели, или в един клас. Пита се наново всеки път — списък, прочетен
    при отварянето на страницата, щеше да държи вратата отворена след това."""
    if a_id == b_id:
        return True
    link = _pair(db, a_id, b_id)
    if link and link.status == "accepted":
        return True
    mine = {r[0] for r in db.query(ClassroomMember.classroom_id)
            .filter(ClassroomMember.student_user_id == a_id)}
    if not mine:
        return False
    return bool(db.query(ClassroomMember.id)
                .filter(ClassroomMember.student_user_id == b_id,
                        ClassroomMember.classroom_id.in_(mine)).first())


def _as_link(link: Friendship, me_id: str) -> dict:
    return {
        "id": link.id,
        "status": link.status,
        "mine": link.requester_id == me_id,
    }


@router.post("/friends/code/{code}")
def add_friend(code: str,
               user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    target = (db.query(SocialProfile)
              .filter(SocialProfile.friend_code == code.strip().upper())
              .first())
    if not target:
        raise HTTPException(404, "No one has that code.")
    if target.user_id == user.id:
        raise HTTPException(400, "That is your own code.")

    existing = _pair(db, user.id, target.user_id)
    if existing:
        # Другият вече е поканил мен: това е съгласие и от двете страни, така
        # че се приема, вместо да се прави втора висяща покана в обратна посока.
        if existing.status == "pending" and existing.addressee_id == user.id:
            existing.status = "accepted"
            db.commit()
        return _as_link(existing, user.id)

    count = (db.query(func.count(Friendship.id))
             .filter(or_(Friendship.requester_id == user.id,
                         Friendship.addressee_id == user.id)).scalar() or 0)
    if count >= MAX_FRIENDS:
        raise HTTPException(400, "That is as many as Climby keeps.")

    link = Friendship(requester_id=user.id, addressee_id=target.user_id, status="pending")
    db.add(link)
    db.commit()
    db.refresh(link)
    return _as_link(link, user.id)


@router.post("/friends/{link_id}/accept")
def accept_friend(link_id: str,
                  user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    link = db.query(Friendship).filter(Friendship.id == link_id).first()
    if not link:
        raise HTTPException(404, "No such request.")
    if link.addressee_id != user.id:
        raise HTTPException(403, "That request was not sent to you.")
    link.status = "accepted"
    db.commit()
    return _as_link(link, user.id)


@router.get("/friends")
def list_friends(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    links = (db.query(Friendship)
             .filter(or_(Friendship.requester_id == user.id,
                         Friendship.addressee_id == user.id))
             .all())
    friends, waiting = [], []
    for link in links:
        other_id = link.addressee_id if link.requester_id == user.id else link.requester_id
        other = db.query(User).filter(User.id == other_id).first()
        if not other:
            continue
        row = {"link_id": link.id, "user_id": other.id, "name": other.display_name,
               "grade": other.grade}
        if link.status == "accepted":
            friends.append({**row, **_stats(db, other.id)})
        else:
            waiting.append({**row, "they_asked": link.addressee_id == user.id})
    friends.sort(key=lambda r: r["clibis"], reverse=True)
    return {"friends": friends, "pending": waiting}


@router.delete("/friends/{link_id}")
def remove_friend(link_id: str,
                  user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    link = db.query(Friendship).filter(Friendship.id == link_id).first()
    if not link:
        raise HTTPException(404, "No such friend.")
    if user.id not in (link.requester_id, link.addressee_id):
        raise HTTPException(403, "That is not yours to remove.")
    db.delete(link)
    db.commit()
    return {"status": "ok"}


@router.get("/profile/{user_id}")
def profile(user_id: str,
            user: User = Depends(get_current_user),
            db: Session = Depends(get_db)):
    if not are_connected(db, user.id, user_id):
        raise HTTPException(403, "You can only see people you climb with.")
    other = db.query(User).filter(User.id == user_id).first()
    if not other:
        raise HTTPException(404, "No such climber.")
    return {"name": other.display_name, "grade": other.grade, **_stats(db, user_id)}


# ----------------------------------------------------------------- класациите


def _week_start(day: Optional[date] = None) -> date:
    day = day or datetime.now(timezone.utc).date()
    return day - timedelta(days=day.weekday())


def _earned(db: Session, ids: List[str], since: Optional[datetime]) -> dict:
    """Спечеленото, не балансът: похарченото за клин не бива да сваля от
    класацията — иначе ученикът избира между серията си и мястото си."""
    if not ids:
        return {}
    q = (db.query(ClibiLedger.user_id, func.coalesce(func.sum(ClibiLedger.amount), 0))
         .filter(ClibiLedger.user_id.in_(ids), ClibiLedger.amount > 0))
    if since is not None:
        q = q.filter(ClibiLedger.created_at >= since)
    return {row[0]: int(row[1] or 0) for row in q.group_by(ClibiLedger.user_id)}


# ------------------------------------------------------------------ свръзката


class RopeIn(BaseModel):
    target: int = Field(ge=10, le=600)


def _canonical(a_id: str, b_id: str):
    """Двойката се пази подредена, за да няма два реда за една свръзка —
    уникалността в базата пази само реда, в който е записана."""
    return (a_id, b_id) if a_id < b_id else (b_id, a_id)


def _week_window(start: date):
    begin = datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc)
    return begin, begin + timedelta(days=7)


def _earned_between(db: Session, user_id: str, begin: datetime, end: datetime) -> int:
    total = (db.query(func.coalesce(func.sum(ClibiLedger.amount), 0))
             .filter(ClibiLedger.user_id == user_id,
                     ClibiLedger.amount > 0,
                     ClibiLedger.created_at >= begin,
                     ClibiLedger.created_at < end)
             .scalar())
    return int(total or 0)


def _my_rope_row(db: Session, user_id: str) -> Optional[RopePartner]:
    return (db.query(RopePartner)
            .filter(or_(RopePartner.a_user_id == user_id, RopePartner.b_user_id == user_id))
            .order_by(RopePartner.week_start.desc())
            .first())


@router.post("/rope/{friend_id}")
def tie_rope(friend_id: str,
             body: RopeIn,
             user: User = Depends(get_current_user),
             db: Session = Depends(get_db)):
    """Една цел за двама за една седмица."""
    link = _pair(db, user.id, friend_id)
    if not link or link.status != "accepted":
        raise HTTPException(403, "You can only tie in with a friend.")

    start = _week_start()
    mine = (db.query(RopePartner)
            .filter(or_(RopePartner.a_user_id == user.id, RopePartner.b_user_id == user.id),
                    RopePartner.week_start == start)
            .first())
    if mine:
        raise HTTPException(400, "You are already tied in this week.")

    a_id, b_id = _canonical(user.id, friend_id)
    rope = RopePartner(a_user_id=a_id, b_user_id=b_id, week_start=start, target=body.target)
    db.add(rope)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "You are already tied in this week.")
    db.refresh(rope)
    return {"id": rope.id, "target": rope.target, "week_start": rope.week_start}


@router.get("/rope")
def my_rope(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Текущата свръзка, и плащането за миналата, ако е дошло времето му.

    Разплаща се при четене, а не по часовник. Render приспива безплатната
    услуга и часовник там просто не се случва — същата причина, поради която
    _sweep_guest_briefs мете в движение.
    """
    rope = _my_rope_row(db, user.id)
    if not rope:
        return {"rope": None}

    begin, end = _week_window(rope.week_start)
    other_id = rope.b_user_id if rope.a_user_id == user.id else rope.a_user_id
    mine = _earned_between(db, user.id, begin, end)
    theirs = _earned_between(db, other_id, begin, end)

    if not rope.settled and rope.week_start < _week_start():
        # Платено е само ако И ДВАМАТА са стигнали. Това е самата идея: срещу
        # другите се играе в класацията, а тук единственият начин да спечелиш е
        # и другият да успее.
        if mine >= rope.target and theirs >= rope.target:
            clibis.award_quietly(db, user.id, "rope_bonus", rope.id)
            clibis.award_quietly(db, other_id, "rope_bonus", rope.id)
        # Приключва се и в двата случая: пропусната седмица не бива да се
        # преглежда наново при всяко отваряне до края на времето.
        rope.settled = True
        db.commit()

    other = db.query(User).filter(User.id == other_id).first()
    return {
        "id": rope.id,
        "rope": True,
        "partner": other.display_name if other else None,
        "partner_id": other_id,
        "week_start": rope.week_start,
        "target": rope.target,
        "mine": mine,
        "theirs": theirs,
        "settled": rope.settled,
        "current": rope.week_start == _week_start(),
    }


@router.get("/leaderboard")
# Обикновени стойности по подразбиране, не Query(...): FastAPI ги чете по
# същия начин като заявка, а така функцията може да бъде извикана и пряко.
def leaderboard(scope: str = "friends",
                period: str = "all",
                user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    if scope not in ("friends", "class", "global"):
        raise HTTPException(400, "No such board.")
    since = (datetime.combine(_week_start(), datetime.min.time(), tzinfo=timezone.utc)
             if period == "week" else None)

    if scope == "global":
        # Прякори и нищо друго. Истинското име не стига дотук изобщо — не се
        # филтрира по-късно, а никога не се чете.
        rows = (db.query(SocialProfile.user_id, SocialProfile.nickname)
                .filter(SocialProfile.on_global_board.is_(True),
                        SocialProfile.nickname.isnot(None))
                .all())
        names = {r[0]: r[1] for r in rows}
    else:
        if scope == "friends":
            links = (db.query(Friendship)
                     .filter(or_(Friendship.requester_id == user.id,
                                 Friendship.addressee_id == user.id),
                             Friendship.status == "accepted").all())
            ids = {user.id} | {
                link.addressee_id if link.requester_id == user.id else link.requester_id
                for link in links
            }
        else:
            mine = {r[0] for r in db.query(ClassroomMember.classroom_id)
                    .filter(ClassroomMember.student_user_id == user.id)}
            ids = {r[0] for r in db.query(ClassroomMember.student_user_id)
                   .filter(ClassroomMember.classroom_id.in_(mine))} | {user.id} if mine else {user.id}
        names = {r[0]: r[1] for r in db.query(User.id, User.display_name)
                 .filter(User.id.in_(list(ids)))}

    earned = _earned(db, list(names.keys()), since)
    board = [{"name": names[uid], "clibis": earned.get(uid, 0), "you": uid == user.id}
             for uid in names]
    board.sort(key=lambda r: (-r["clibis"], r["name"] or ""))
    for place, row in enumerate(board, start=1):
        row["place"] = place
    return {"scope": scope, "period": period, "rows": board}
