# activity.py — what a student did, as one list of moments.
#
# The home screen shows a line like "Today so far: 2 questions, 25 min. 1 task
# due. 3 days in a row." It used to build that from three list endpoints — and
# two of them are capped (the last 50 questions, the last 30 sessions), so a
# student asking five questions a day could only ever see about ten days of
# history, and their streak silently stopped at two weeks. Exactly the student
# the streak is for.
#
# This returns every moment of effort in the last N days as (when, what, how
# long), uncapped within that window, and leaves "which calendar day is that"
# to the client — because the day a child remembers is the one in their time
# zone, and the server doesn't know it.
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from db import get_db
from focus_sessions import MIN_SESSION_SECONDS
from models import FocusSession, ScanHistory, Task, User

router = APIRouter(prefix="/activity", tags=["activity"])

# Long enough for any streak worth showing, short enough to stay one request.
WINDOW_DAYS = 120
MAX_EVENTS = 3000


class ActivityEvent(BaseModel):
    at: datetime
    kind: str            # "question" | "session" | "task"
    seconds: int = 0     # sessions only


class ActivityOut(BaseModel):
    events: List[ActivityEvent]
    due_today: int


@router.get("", response_model=ActivityOut)
def activity(
    # The client's calendar date, because "today" is a local fact. Without it we
    # fall back to UTC, which is right for nobody in Bulgaria after 3am.
    today: Optional[date] = Query(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)
    events: List[ActivityEvent] = []

    # SQLite returns these naive; Postgres returns them aware. A naive ISO
    # string is read by a browser as LOCAL time, which moves a UTC moment by
    # the time-zone offset and can put it on the wrong calendar day. Say UTC
    # explicitly, whichever database answered.
    def utc(dt: datetime) -> datetime:
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)

    for row in (db.query(ScanHistory.created_at)
                .filter(ScanHistory.user_id == user.id, ScanHistory.created_at >= since)):
        events.append(ActivityEvent(at=utc(row[0]), kind="question"))

    for row in (db.query(FocusSession.created_at, FocusSession.duration_seconds)
                .filter(FocusSession.user_id == user.id,
                        FocusSession.created_at >= since,
                        FocusSession.duration_seconds >= MIN_SESSION_SECONDS)):
        events.append(ActivityEvent(at=utc(row[0]), kind="session", seconds=row[1]))

    for row in (db.query(Task.completed_at)
                .filter(Task.user_id == user.id, Task.done.is_(True),
                        Task.completed_at.isnot(None), Task.completed_at >= since)):
        events.append(ActivityEvent(at=utc(row[0]), kind="task"))

    events.sort(key=lambda e: e.at, reverse=True)
    events = events[:MAX_EVENTS]

    day = today or datetime.now(timezone.utc).date()
    due_today = (db.query(Task)
                 .filter(Task.user_id == user.id, Task.done.is_(False), Task.deadline == day)
                 .count())

    return ActivityOut(events=events, due_today=due_today)
