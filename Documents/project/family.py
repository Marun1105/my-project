# family.py — родителски изглед: ученикът дава код, родителят го въвежда и вижда
# ОБОБЩЕН напредък (брой задачи, минути фокус, серия). Умишлено НЕ показваме текста
# на задачите или въпросите към учителя — ако детето знае, че всеки въпрос се чете,
# спира да пита честно, а точно питането е смисълът на приложението.
import secrets
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

import rate_limit
from auth import get_current_user
from db import get_db
from focus_sessions import MIN_SESSION_SECONDS
from models import FamilyInvite, FamilyLink, FocusSession, Task, User
from schemas import FamilyInviteOut, FamilyLinkRequest, StudentProgressOut

router = APIRouter(prefix="/family", tags=["family"])

# Серията се брои по календара на ученика, не по UTC: сесия в 00:30 местно време
# е "днес" за ученика, но "вчера" в UTC — иначе родителят и детето виждат различни
# числа за едно и също нещо. Приложението е за български ученици.
# Ако системата няма база с часови зони (Windows, слим Docker образ), падаме до
# фиксиран UTC+2 — по-добре с час разлика през лятото, отколкото сървърът да не тръгне.
try:
    APP_TZ = ZoneInfo("Europe/Sofia")
except Exception:  # ZoneInfoNotFoundError и подобни
    APP_TZ = timezone(timedelta(hours=2))


def _local_date(dt: datetime):
    return _aware(dt).astimezone(APP_TZ).date()


def _today_local():
    return datetime.now(APP_TZ).date()

INVITE_TTL_HOURS = 48
# без 0/O/1/I — кодът се чете на глас или се преписва от екран
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6


def _generate_code(db: Session) -> str:
    for _ in range(10):
        # secrets, не random: кодът дава достъп до данните на дете, а random е
        # предвидим, ако някой види достатъчно негови изходи
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if not db.query(FamilyInvite).filter(FamilyInvite.code == code).first():
            return code
    raise HTTPException(500, "Не успях да създам код. Опитай пак.")


def _aware(dt: datetime) -> datetime:
    # SQLite връща naive стойности, макар да са записани в UTC
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.post("/invite", response_model=FamilyInviteOut)
def create_invite(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rate_limit.enforce(request, "family-invite", max_calls=10, window_seconds=3600,
                        message="Твърде много кодове за кратко време — изчакай малко.")
    code = _generate_code(db)
    invite = FamilyInvite(
        student_user_id=user.id,
        code=code,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=INVITE_TTL_HOURS),
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return FamilyInviteOut(code=invite.code, expires_at=invite.expires_at)


@router.post("/link")
def link_student(
    body: FamilyLinkRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # 6 знака от 32-буквена азбука е ~1 милиард комбинации, но без лимит все пак
    # може да се налучква масово — ограничаваме опитите за въвеждане на код
    rate_limit.enforce(request, "family-link", max_calls=10, window_seconds=3600,
                        message="Твърде много опити с код — изчакай малко и опитай пак.")
    code = body.code.strip().upper()
    invite = db.query(FamilyInvite).filter(FamilyInvite.code == code).first()
    if not invite or invite.used:
        raise HTTPException(400, "Невалиден или вече използван код.")
    if _aware(invite.expires_at) < datetime.now(timezone.utc):
        raise HTTPException(400, "Кодът е изтекъл. Помоли за нов.")
    if invite.student_user_id == user.id:
        raise HTTPException(400, "Не можеш да се свържеш със собствения си акаунт.")

    existing = db.query(FamilyLink).filter(
        FamilyLink.parent_user_id == user.id,
        FamilyLink.student_user_id == invite.student_user_id,
    ).first()
    if existing:
        raise HTTPException(400, "Вече си свързан с този ученик.")

    # Маркираме кода за използван с условен UPDATE: ако две заявки дойдат едновременно,
    # само едната ще засегне ред и само тя създава връзка (иначе "еднократният" код
    # може да се осребри два пъти).
    claimed = (
        db.query(FamilyInvite)
        .filter(FamilyInvite.id == invite.id, FamilyInvite.used.is_(False))
        .update({FamilyInvite.used: True}, synchronize_session=False)
    )
    if not claimed:
        db.rollback()
        raise HTTPException(400, "Невалиден или вече използван код.")

    db.add(FamilyLink(parent_user_id=user.id, student_user_id=invite.student_user_id))
    db.commit()
    return {"status": "ok"}


def _streak_from_days(days: Iterable) -> int:
    days = set(days)
    if not days:
        return 0
    cursor = _today_local()
    if cursor not in days:
        cursor -= timedelta(days=1)
        if cursor not in days:
            return 0
    streak = 0
    while cursor in days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


# ---------------------------------------------------------------------------
# Обобщените числа за група ученици. Ползват се и от родителския изглед тук, и от
# учителския в classes.py — двата показват едно и също и е по-добре да го смятат
# на едно място, отколкото да се разминат някой ден.
#
# Досега за всеки ученик поотделно се дърпаха ВСИЧКИТЕ му задачи и ВСИЧКИТЕ му
# сесии като обекти, за да се преброят в Python. За учител с тридесет класа по
# тридесет ученици това е към две хиляди обиколки до базата на едно отваряне на
# страницата. Броенето е работа на базата; тук остава само това, което тя не
# може да свърши преносимо.
# ---------------------------------------------------------------------------

# Серията е низ от последователни дни до днес, затова сесия отпреди повече от
# година не може да я удължи, без да има сесия и във всеки ден между двете.
# Границата пази заявката да не издърпа цялата история на всички ученици наведнъж.
STREAK_LOOKBACK_DAYS = 400

# SQLite приема най-много 999 стойности в един IN (...). Postgres няма такъв
# праг, но разделянето на партиди не му пречи.
_ID_BATCH = 400


def _batched(ids: Iterable[str]):
    ids = list(ids)
    for start in range(0, len(ids), _ID_BATCH):
        yield ids[start:start + _ID_BATCH]


def _users_by_id(db: Session, ids: Iterable[str]) -> Dict[str, User]:
    found: Dict[str, User] = {}
    for batch in _batched(set(ids)):
        for student in db.query(User).filter(User.id.in_(batch)).all():
            found[student.id] = student
    return found


def _progress_by_student(db: Session, student_ids: Iterable[str]) -> Dict[str, dict]:
    ids = list(set(student_ids))
    result = {
        sid: {"tasks_pending": 0, "tasks_done": 0, "tasks_overdue": 0,
              "focus_minutes_7d": 0, "focus_streak_days": 0}
        for sid in ids
    }
    if not ids:
        return result

    today = _today_local()
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    streak_floor = now - timedelta(days=STREAK_LOOKBACK_DAYS)

    # case(...) вместо count(...).filter(...): FILTER е по-четимо, но иска SQLite 3.30+,
    # а тази форма върви навсякъде.
    n_pending = func.sum(case((Task.done.is_(False), 1), else_=0))
    n_done = func.sum(case((Task.done.is_(True), 1), else_=0))
    n_overdue = func.sum(case(
        (and_(Task.done.is_(False), Task.deadline.isnot(None), Task.deadline < today), 1),
        else_=0,
    ))

    for batch in _batched(ids):
        for sid, pending, done, overdue in (
            db.query(Task.user_id, n_pending, n_done, n_overdue)
            .filter(Task.user_id.in_(batch))
            .group_by(Task.user_id)
            .all()
        ):
            result[sid].update(
                tasks_pending=int(pending or 0),
                tasks_done=int(done or 0),
                tasks_overdue=int(overdue or 0),
            )

        # "последните седем дни" минава в SQL: досега се четяха всички сесии и се
        # филтрираха след това.
        for sid, seconds in (
            db.query(FocusSession.user_id, func.sum(FocusSession.duration_seconds))
            .filter(
                FocusSession.user_id.in_(batch),
                FocusSession.duration_seconds >= MIN_SESSION_SECONDS,
                FocusSession.created_at >= week_ago,
            )
            .group_by(FocusSession.user_id)
            .all()
        ):
            result[sid]["focus_minutes_7d"] = round((seconds or 0) / 60)

        # Серията иска РАЗЛИЧНИТЕ дни по календара на ученика, а превръщането на UTC
        # в местна дата не се пише еднакво в SQLite и в Postgres. Затова остава в
        # Python — но заявката вади само две колони и само за прозореца на серията,
        # вместо цялата история като ORM обекти.
        days = defaultdict(set)
        for sid, created_at in (
            db.query(FocusSession.user_id, FocusSession.created_at)
            .filter(
                FocusSession.user_id.in_(batch),
                FocusSession.duration_seconds >= MIN_SESSION_SECONDS,
                FocusSession.created_at >= streak_floor,
            )
            .distinct()
            .all()
        ):
            days[sid].add(_local_date(created_at))
        for sid, dates in days.items():
            result[sid]["focus_streak_days"] = _streak_from_days(dates)

    return result


def _progress_out(student: User, linked_at: datetime, numbers: dict) -> StudentProgressOut:
    return StudentProgressOut(
        student_id=student.id,
        display_name=student.display_name,
        linked_at=linked_at,
        **numbers,
    )


@router.get("/students", response_model=List[StudentProgressOut])
def list_students(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    links = db.query(FamilyLink).filter(FamilyLink.parent_user_id == user.id).all()
    if not links:
        return []

    students = _users_by_id(db, (link.student_user_id for link in links))
    numbers = _progress_by_student(db, students)

    out = []
    for link in links:
        student = students.get(link.student_user_id)
        if student:
            out.append(_progress_out(student, link.created_at, numbers[student.id]))
    return out


@router.delete("/students/{student_id}")
def unlink_student(student_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    link = db.query(FamilyLink).filter(
        FamilyLink.parent_user_id == user.id,
        FamilyLink.student_user_id == student_id,
    ).first()
    if not link:
        raise HTTPException(404, "Няма такава връзка.")
    db.delete(link)
    db.commit()
    return {"status": "ok"}


@router.get("/parents")
def list_parents(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Ученикът вижда кой го следи и може да прекъсне връзката по всяко време."""
    links = db.query(FamilyLink).filter(FamilyLink.student_user_id == user.id).all()
    result = []
    for link in links:
        parent = db.get(User, link.parent_user_id)
        if parent:
            result.append({"parent_id": parent.id, "display_name": parent.display_name, "linked_at": link.created_at})
    return result


@router.delete("/parents/{parent_id}")
def revoke_parent(parent_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    link = db.query(FamilyLink).filter(
        FamilyLink.parent_user_id == parent_id,
        FamilyLink.student_user_id == user.id,
    ).first()
    if not link:
        raise HTTPException(404, "Няма такава връзка.")
    db.delete(link)
    db.commit()
    return {"status": "ok"}
