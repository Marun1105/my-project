# usage.py — a ceiling on what the AI can cost in a day.
#
# The per-account limits stop one person from running up the bill. Nothing
# stopped everyone together: a hundred enthusiastic students in exam week was
# a bill with no top. This counts tokens for the whole app, per calendar day,
# in the database — so every worker sees the same number — and refuses kindly
# once the day's budget is spent. The budget is one number in the environment.
#
# Tokens, not calls: a photo of a dense page costs fifty times a one-line chat
# question, and a cap on calls would let the expensive kind through.
import os
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import Column, Date, Integer, text
from sqlalchemy.orm import Session

from db import Base

# Haiku 4.5 is roughly $1 per million input tokens and $5 per million output.
# Three million tokens a day is on the order of ten dollars a day at the very
# worst mix, and far more questions than the app has ever seen in a week.
def _cap_from_env(default: int = 3_000_000) -> int:
    # A blank value (saved when "clearing" it in Render) or a stray character
    # must not stop the app from booting on the next deploy. A spend knob is
    # not worth an outage: fall back, say so once.
    raw = os.environ.get("AI_DAILY_TOKEN_CAP")
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip().replace("_", "").replace(",", ""))
    except ValueError:
        print(f"[usage] AI_DAILY_TOKEN_CAP={raw!r} is not a number — using {default}", flush=True)
        return default


DAILY_TOKEN_CAP = _cap_from_env()

# What the student reads when the day's budget is spent. Not an error: the
# tutor is resting, and says when it is back.
CAP_MESSAGE = {
    "en": "ClimbAI has answered a lot of questions today and is taking a rest. It will be back tomorrow.",
    "bg": "ClimbAI отговори на много въпроси днес и си почива. Ще се върне утре.",
}


class AiUsage(Base):
    """One row per calendar day (UTC). Created by create_all like any table."""
    __tablename__ = "ai_usage"
    day = Column(Date, primary_key=True)
    calls = Column(Integer, nullable=False, default=0, server_default="0")
    tokens = Column(Integer, nullable=False, default=0, server_default="0")


def _today():
    return datetime.now(timezone.utc).date()


def today(db: Session) -> dict:
    row = db.query(AiUsage).filter(AiUsage.day == _today()).first()
    return {"day": _today().isoformat(), "calls": row.calls if row else 0,
            "tokens": row.tokens if row else 0, "cap": DAILY_TOKEN_CAP}


def check(db: Session, lang: str = "en") -> None:
    """Refuse before spending, once the day's budget is gone."""
    if DAILY_TOKEN_CAP <= 0:
        return
    if today(db)["tokens"] >= DAILY_TOKEN_CAP:
        raise HTTPException(503, CAP_MESSAGE.get(lang, CAP_MESSAGE["en"]))


def record(db: Session, resp) -> None:
    """Add this answer's tokens to the day. Atomic: workers race, rows don't.

    Runs after the paid call. If the database hiccups here the answer has
    already been bought; a bookkeeping failure must not turn it into a 500
    and throw it away. Best effort, logged.
    """
    try:
        _record(db, resp)
    except Exception as err:  # noqa: BLE001 — anything; the answer matters more
        db.rollback()
        print(f"[usage] could not record tokens: {err!r}", flush=True)


def _record(db: Session, resp) -> None:
    used = 0
    usage = getattr(resp, "usage", None)
    if usage is not None:
        used = int(getattr(usage, "input_tokens", 0) or 0) + int(getattr(usage, "output_tokens", 0) or 0)
    day = _today()
    # insert-if-missing, then a relative UPDATE, so two workers adding at the
    # same moment both land instead of one overwriting the other
    if db.query(AiUsage).filter(AiUsage.day == day).first() is None:
        try:
            db.add(AiUsage(day=day, calls=0, tokens=0))
            db.commit()
        except Exception:
            db.rollback()  # the other worker got there first; fine
    db.execute(text("UPDATE ai_usage SET calls = calls + 1, tokens = tokens + :n WHERE day = :d"),
               {"n": used, "d": day})
    db.commit()
