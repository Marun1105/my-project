# holds.py — the currency: how holds are earned, and how many someone has.
#
# Holds are the grips on a climbing wall. They are earned by studying and are
# never bought and never buy help: no hint, no answer, no skip costs holds.
#
# Every hold is one row in hold_entries with a (reason, ref) that can pay only
# once — the same solved question, the same task, the same focus session, the
# same day — so a retried request, a double click or a race between two
# workers can never pay twice. Earning is best effort: a failure here must
# never cost the student the thing they actually did (the answer, the task,
# the session), so callers wrap it and carry on.
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import HoldEntry

SOLVED = 3              # solved it on your own (judged by ClimbAI, not claimed)
ON_TIME = 2             # a task with a deadline, finished by it
TASK_DONE = 1           # a task without a deadline, finished
FOCUS_PER_15_MIN = 1    # each full quarter hour of a focus session
STREAK_DAY = 1          # one more day in a row
BREAK = 1               # taking the break Climby suggested
CHEER = 1               # a friend's cheer

# Caps per day, so the honest way is the only way that pays.
FOCUS_DAILY_CAP = 8     # two hours of focus
TASKS_DAILY_CAP = 6     # tasks, with or without a deadline
BREAKS_DAILY_CAP = 2

# Earned by the student themself — what a streak day counts. A cheer received
# is a gift and keeps nobody's streak alive.
OWN_REASONS = ("solved", "on_time", "task", "focus", "break")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def day_start(at: datetime = None) -> datetime:
    at = at or _now()
    return at.replace(hour=0, minute=0, second=0, microsecond=0)


def week_start(at: datetime = None) -> datetime:
    """Monday 00:00 UTC: the week a group compares."""
    start = day_start(at)
    return start - timedelta(days=start.weekday())


def _as_utc(dt: datetime) -> datetime:
    # SQLite hands timestamps back without a zone; Postgres with one.
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def award(db: Session, user_id: str, reason: str, ref: str, amount: int) -> int:
    """Add holds once per (reason, ref). Returns what was added (0 if it already was).

    Runs in a savepoint: a duplicate caught by the unique constraint rolls back
    only this row, never the caller's own work in the same transaction."""
    if amount <= 0 or not user_id:
        return 0
    ref = str(ref)[:120]
    exists = db.query(HoldEntry.id).filter(
        HoldEntry.user_id == user_id, HoldEntry.reason == reason, HoldEntry.ref == ref).first()
    if exists:
        return 0
    try:
        with db.begin_nested():
            db.add(HoldEntry(user_id=user_id, reason=reason, ref=ref, amount=amount))
    except IntegrityError:
        return 0
    if reason in OWN_REASONS:
        _streak(db, user_id)
    return amount


def _earned_today(db: Session, user_id: str, reasons) -> int:
    total = db.query(func.coalesce(func.sum(HoldEntry.amount), 0)).filter(
        HoldEntry.user_id == user_id, HoldEntry.reason.in_(reasons),
        HoldEntry.created_at >= day_start()).scalar()
    return int(total or 0)


def _streak(db: Session, user_id: str) -> None:
    """The first own hold of a day pays one more if yesterday had one too."""
    today = day_start()
    yesterday = today - timedelta(days=1)
    had_yesterday = db.query(HoldEntry.id).filter(
        HoldEntry.user_id == user_id, HoldEntry.reason.in_(OWN_REASONS),
        HoldEntry.created_at >= yesterday, HoldEntry.created_at < today).first()
    if had_yesterday:
        award(db, user_id, "streak", today.date().isoformat(), STREAK_DAY)


# ---------------------------------------------------------------------------
# the moments that earn
# ---------------------------------------------------------------------------

def on_solved(db: Session, user_id: str, scan_id: str) -> int:
    return award(db, user_id, "solved", scan_id, SOLVED)


def on_task_done(db: Session, user_id: str, task) -> int:
    """A task ticked off. On time pays more; ticking, unticking and ticking
    again pays once, because the ref is the task."""
    if not task.done or not task.completed_at:
        return 0
    left = TASKS_DAILY_CAP - _earned_today(db, user_id, ("on_time", "task"))
    if left <= 0:
        return 0
    if task.deadline:
        if _as_utc(task.completed_at).date() > task.deadline:
            return 0
        return award(db, user_id, "on_time", task.id, min(ON_TIME, left))
    return award(db, user_id, "task", task.id, min(TASK_DONE, left))


def on_focus(db: Session, user_id: str, session) -> int:
    quarters = int(max(0, session.duration_seconds or 0) // 900) * FOCUS_PER_15_MIN
    left = FOCUS_DAILY_CAP - _earned_today(db, user_id, ("focus",))
    return award(db, user_id, "focus", session.id, min(quarters, max(0, left)))


def on_break(db: Session, user_id: str) -> int:
    taken = db.query(func.count(HoldEntry.id)).filter(
        HoldEntry.user_id == user_id, HoldEntry.reason == "break",
        HoldEntry.created_at >= day_start()).scalar() or 0
    if taken >= BREAKS_DAILY_CAP:
        return 0
    return award(db, user_id, "break", f"{day_start().date().isoformat()}#{taken + 1}", BREAK)


def on_cheer(db: Session, from_id: str, to_id: str) -> int:
    """Once a day per friend: the ref is who cheered, and on which day."""
    return award(db, to_id, "cheer", f"{from_id}:{day_start().date().isoformat()}", CHEER)


# ---------------------------------------------------------------------------
# reading
# ---------------------------------------------------------------------------

def totals(db: Session, user_ids) -> dict:
    """{user_id: {"total", "week", "streak"}} for many people in three queries."""
    ids = list({i for i in user_ids if i})
    out = {i: {"total": 0, "week": 0, "streak": 0} for i in ids}
    if not ids:
        return out
    for uid, total in (db.query(HoldEntry.user_id, func.sum(HoldEntry.amount))
                       .filter(HoldEntry.user_id.in_(ids)).group_by(HoldEntry.user_id)):
        out[uid]["total"] = int(total or 0)
    for uid, week in (db.query(HoldEntry.user_id, func.sum(HoldEntry.amount))
                      .filter(HoldEntry.user_id.in_(ids), HoldEntry.created_at >= week_start())
                      .group_by(HoldEntry.user_id)):
        out[uid]["week"] = int(week or 0)
    # the streak: consecutive days with an own hold, ending today or yesterday
    since = day_start() - timedelta(days=60)
    days = {i: set() for i in ids}
    for uid, at in (db.query(HoldEntry.user_id, HoldEntry.created_at)
                    .filter(HoldEntry.user_id.in_(ids), HoldEntry.reason.in_(OWN_REASONS),
                            HoldEntry.created_at >= since)):
        days[uid].add(_as_utc(at).date())
    today = _now().date()
    for uid, seen in days.items():
        d = today if today in seen else today - timedelta(days=1)
        n = 0
        while d in seen:
            n += 1
            d -= timedelta(days=1)
        out[uid]["streak"] = n
    return out


def today_utc() -> date:
    return _now().date()
