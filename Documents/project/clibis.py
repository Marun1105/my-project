# -*- coding: utf-8 -*-
# clibis.py — the currency, and the only place that writes it.
#
# Every rate here is a statement about what Climby wants a student to do, so
# they are worth reading as a sentence rather than a table: solving a step
# yourself pays more than finishing a task, finishing a task pays more than
# sitting at the desk, and asking ClimbAI a question pays nothing at all. If
# asking for the answer were the fastest way to get rich, the currency would
# teach the opposite of what the app is for.
#
# Nothing in the HTTP layer may call award(). It is called from the three
# places where work is actually recorded — a task turning done, a focus
# session saved, an answer the tutor marked as solved unaided — because those
# are facts about work, and a request is only a claim about one.
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import ClibiLedger

# Решението, което не е число: solved_step е единственото, което расте, когато
# ученикът се нуждае от помощ по-малко (виж ScanHistory.solved_unaided), затова
# плаща най-много. За зададен въпрос не се плаща нищо — няма такъв ред тук.
RATES = {
    "solved_step": 15,
    "task_done": 10,
    "focus_session": 5,
    "streak_day": 5,
    "rope_bonus": 25,
}

# Висок таван: честен тежък ден — десет задачи, две сесии и няколко решени сам
# стъпки — стига до около сто. Таванът не е за него, а за ученика, който е
# намерил как да отмята една и съща задача в кръг.
DAILY_CAP = 120


def _today_start() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def earned_today(db: Session, user_id: str) -> int:
    """Only earnings count against the cap. Spending does not give back room."""
    total = (db.query(func.coalesce(func.sum(ClibiLedger.amount), 0))
             .filter(ClibiLedger.user_id == user_id,
                     ClibiLedger.amount > 0,
                     ClibiLedger.created_at >= _today_start())
             .scalar())
    return int(total or 0)


def balance(db: Session, user_id: str) -> int:
    total = (db.query(func.coalesce(func.sum(ClibiLedger.amount), 0))
             .filter(ClibiLedger.user_id == user_id)
             .scalar())
    return int(total or 0)


def award(db: Session, user_id: str, reason: str, ref_id: str) -> int:
    """Pay for one piece of work. Returns what was actually granted.

    Zero means "already paid for" or "the cap is reached" — both ordinary, and
    neither is an error the caller should report. A KeyError means the caller
    wrote a reason that does not exist, which is a bug and should stop them.
    """
    amount = RATES[reason]                      # deliberately not .get()

    room = DAILY_CAP - earned_today(db, user_id)
    if room <= 0:
        return 0
    amount = min(amount, room)

    row = ClibiLedger(user_id=user_id, amount=amount, reason=reason, ref_id=str(ref_id))
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # The unique constraint did its job: this work was already paid for.
        # Nothing to report — the student's balance is already correct.
        db.rollback()
        return 0
    return amount


def spend(db: Session, user_id: str, amount: int, reason: str, ref_id: str) -> bool:
    """Take clibis away by writing a negative row, never by deleting one.

    False means there was not enough, or this exact purchase was already made.
    """
    if amount <= 0:
        return False
    if balance(db, user_id) < amount:
        return False

    row = ClibiLedger(user_id=user_id, amount=-amount, reason=reason, ref_id=str(ref_id))
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False
    return True


def award_quietly(db: Session, user_id: Optional[str], reason: str, ref_id: str) -> int:
    """award(), for the call sites that ride on a request doing something else.

    A task is marked done, a session is saved, an answer is bought and paid
    for. None of those may fail because the currency had a bad moment, so
    everything here is swallowed and printed — the same bargain server.py
    already makes when it writes ScanHistory.
    """
    if not user_id:
        return 0
    try:
        return award(db, user_id, reason, ref_id)
    except Exception as err:  # noqa: BLE001
        db.rollback()
        print(f"[clibis] could not award {reason}: {err!r}", flush=True)
        return 0


def award_day(db: Session, user_id: Optional[str], day: Optional[date] = None) -> int:
    """One payment for turning up, once per day, whatever else was done.

    Keyed on the UTC date so it needs nothing from the client. The streak the
    student sees is still counted in their own time zone by the browser; this
    is only the payment, and being a few hours out on which day it landed costs
    nobody anything.
    """
    stamp = (day or datetime.now(timezone.utc).date()).isoformat()
    return award_quietly(db, user_id, "streak_day", stamp)
