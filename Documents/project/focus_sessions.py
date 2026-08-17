# focus_sessions.py — история от фокус сесиите (само за да смятаме серия от дни/статистика);
# самото разпознаване остава изцяло в браузъра, тук се пази само продължителност и % фокус.
from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import get_current_user
from db import get_db
from models import FocusSession, User
from schemas import FocusSessionIn, FocusSessionOut

router = APIRouter(prefix="/focus", tags=["focus"])

# кратки/случайни сесии не бива да броят за статистиката
MIN_SESSION_SECONDS = 60


@router.post("", response_model=FocusSessionOut)
def create_session(body: FocusSessionIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    session = FocusSession(
        user_id=user.id,
        duration_seconds=max(0, body.duration_seconds),
        focus_pct=body.focus_pct,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("", response_model=List[FocusSessionOut])
def list_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.query(FocusSession)
        .filter(FocusSession.user_id == user.id, FocusSession.duration_seconds >= MIN_SESSION_SECONDS)
        .order_by(FocusSession.created_at.desc())
        .limit(30)
        .all()
    )
