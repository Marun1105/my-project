# family.py — родителски изглед: ученикът дава код, родителят го въвежда и вижда
# ОБОБЩЕН напредък (брой задачи, минути фокус, серия). Умишлено НЕ показваме текста
# на задачите или въпросите към учителя — ако детето знае, че всеки въпрос се чете,
# спира да пита честно, а точно питането е смисълът на приложението.
import random
import string
from datetime import date, datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import rate_limit
from auth import get_current_user
from db import get_db
from models import FamilyInvite, FamilyLink, FocusSession, Task, User
from schemas import FamilyInviteOut, FamilyLinkRequest, StudentProgressOut

router = APIRouter(prefix="/family", tags=["family"])

INVITE_TTL_HOURS = 48
# без 0/O/1/I — кодът се чете на глас или се преписва от екран
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6


def _generate_code(db: Session) -> str:
    for _ in range(10):
        code = "".join(random.choices(CODE_ALPHABET, k=CODE_LENGTH))
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

    invite.used = True
    db.add(FamilyLink(parent_user_id=user.id, student_user_id=invite.student_user_id))
    db.commit()
    return {"status": "ok"}


def _focus_streak(sessions: List[FocusSession]) -> int:
    days = {_aware(s.created_at).date() for s in sessions}
    if not days:
        return 0
    cursor = date.today()
    if cursor not in days:
        cursor -= timedelta(days=1)
        if cursor not in days:
            return 0
    streak = 0
    while cursor in days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


@router.get("/students", response_model=List[StudentProgressOut])
def list_students(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    links = db.query(FamilyLink).filter(FamilyLink.parent_user_id == user.id).all()
    today = date.today()
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)

    out = []
    for link in links:
        student = db.get(User, link.student_user_id)
        if not student:
            continue
        tasks = db.query(Task).filter(Task.user_id == student.id).all()
        sessions = db.query(FocusSession).filter(
            FocusSession.user_id == student.id,
            FocusSession.duration_seconds >= 60,
        ).all()
        recent_seconds = sum(s.duration_seconds for s in sessions if _aware(s.created_at) >= week_ago)

        out.append(StudentProgressOut(
            student_id=student.id,
            display_name=student.display_name,
            tasks_pending=sum(1 for t in tasks if not t.done),
            tasks_done=sum(1 for t in tasks if t.done),
            tasks_overdue=sum(1 for t in tasks if not t.done and t.deadline and t.deadline < today),
            focus_minutes_7d=round(recent_seconds / 60),
            focus_streak_days=_focus_streak(sessions),
            linked_at=link.created_at,
        ))
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
