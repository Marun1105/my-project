# models.py — таблиците в базата: ученици, задачи, кодове за потвърждение
import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, Date, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from db import Base


def _now():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    display_name = Column(String, nullable=False)
    email = Column(String, unique=True, nullable=False, index=True)
    phone = Column(String, unique=True, nullable=True, index=True)
    password_hash = Column(String, nullable=False)
    is_email_verified = Column(Boolean, default=False, nullable=False)
    is_phone_verified = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)

    tasks = relationship("Task", back_populates="owner", cascade="all, delete-orphan")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    text = Column(String, nullable=False)
    subject = Column(String, nullable=True)
    deadline = Column(Date, nullable=True)
    done = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    owner = relationship("User", back_populates="tasks")


class FamilyInvite(Base):
    """Код, който ученикът дава на родителя си, за да види напредъка му."""
    __tablename__ = "family_invites"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    student_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    code = Column(String, unique=True, nullable=False, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)


class FamilyLink(Base):
    """Връзка родител -> ученик. Ролята не се пази в users: родител е този,
    който има поне една такава връзка — така не е нужна миграция на съществуващата таблица."""
    __tablename__ = "family_links"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    parent_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    student_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=_now)


class FocusSession(Base):
    __tablename__ = "focus_sessions"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    duration_seconds = Column(Integer, nullable=False)
    focus_pct = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)


class ScanHistory(Base):
    __tablename__ = "scan_history"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    question = Column(String, nullable=False)
    answer = Column(String, nullable=False)
    lang = Column(String, nullable=False, default="bg")
    created_at = Column(DateTime(timezone=True), default=_now)


class CodePurpose(str, enum.Enum):
    verify_email = "verify_email"
    verify_phone = "verify_phone"
    reset_password = "reset_password"


class VerificationCode(Base):
    __tablename__ = "verification_codes"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    purpose = Column(Enum(CodePurpose), nullable=False)
    code_hash = Column(String, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)
