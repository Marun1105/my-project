# models.py — таблиците в базата: ученици, задачи, кодове за потвърждение
import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, Date, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import relationship

from db import Base


def _now():
    return datetime.now(timezone.utc)


class Role(str, enum.Enum):
    student = "student"
    parent = "parent"
    teacher = "teacher"


# Пази се като обикновен текст, а не като native enum тип: добавянето на колона
# към вече съществуваща таблица е далеч по-просто, а стойностите се проверяват
# в схемите (schemas.py) още преди да стигнат до базата.
ROLE_VALUES = tuple(r.value for r in Role)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    display_name = Column(String, nullable=False)
    # Потребителското име е по желание и може да липсва: акаунтите отпреди него
    # нямат такова, а уникалност върху NULL не пречи — и SQLite, и Postgres
    # позволяват много NULL-а в уникален индекс.
    username = Column(String, unique=True, nullable=True, index=True)
    # Откъде е чул за Climby — отговор от началния въпросник. По желание и без
    # уникалност: това е статистика, не самоличност.
    heard_from = Column(String, nullable=True)
    # Уникалността тук е буквална: и SQLite, и Postgres смятат "Ivan@Abv.bg" и
    # "ivan@abv.bg" за различни низове. Затова адресът се смъква до малки букви
    # още преди записа (auth.normalize_email), а търсенето минава през
    # func.lower(), за да намира и заварените редове с главни букви. Изразен
    # индекс върху lower(email) НЕ правим — SQLAlchemy не може да отрази такъв
    # индекс и всяка следваща рефлексия на таблицата пада.
    email = Column(String, unique=True, nullable=False, index=True)
    # Телефонът НЕ е уникален на ниво база, и това е нарочно. Докато беше,
    # всеки можеше да впише чужд номер, да не го потвърди никога и така да
    # заключи истинския му собственик отвън завинаги — нищо не изтичаше такава
    # заявка. Сега номерът "заема" мястото си едва когато е потвърден, а тази
    # уникалност се пази в auth.py, където се вижда и is_phone_verified.
    phone = Column(String, nullable=True, index=True)
    password_hash = Column(String, nullable=False)
    role = Column(String, nullable=False, default=Role.student.value, server_default=Role.student.value)
    is_email_verified = Column(Boolean, default=False, nullable=False)
    is_phone_verified = Column(Boolean, default=False, nullable=False)
    # Версия на сесиите. Вдига се при смяна на паролата и с това всички издадени
    # дотогава токени спират да важат. Причината е обикновена: детето, което си
    # е останало отворено на училищния компютър и после си смени паролата вкъщи,
    # има право да очаква, че оттам нататък никой не му чете домашните.
    token_version = Column(Integer, nullable=False, default=0, server_default="0")
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


class Classroom(Base):
    """Клас на учител. Учителят вижда СЪЩИТЕ обобщени числа като родител —
    колко задачи и колко фокус — но не и текста на задачите или въпросите към
    учителя. Причината е същата, поради която не ги вижда и родителят: ученик,
    който знае, че всеки въпрос се чете, спира да пита честно."""
    __tablename__ = "classrooms"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    teacher_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    # Кодът за класа е дълготраен (за разлика от еднократния родителски код):
    # учителят го казва веднъж на целия клас и всички се присъединяват с него.
    join_code = Column(String, unique=True, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=_now)


class ClassroomMember(Base):
    __tablename__ = "classroom_members"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    classroom_id = Column(String, ForeignKey("classrooms.id"), nullable=False, index=True)
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


class CodeAttempt(Base):
    """Брояч на сгрешените кодове за един акаунт и една цел.

    Шестцифреният код има един милион възможности — това е достатъчно само ако
    опитите са малко. Досега нямаше таван: с натрупани неизползвани кодове и
    търпелив скрипт познаването на един от тях беше въпрос на часове, а познат
    код за reset_password означава чужд акаунт.

    Отделна таблица, а не колони в users: create_all() създава липсващите
    ТАБЛИЦИ при всяко стартиране, така че тук не е нужна миграция — за разлика
    от нова колона върху вече пълната users.
    """
    __tablename__ = "code_attempts"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    purpose = Column(Enum(CodePurpose), nullable=False)
    failed_count = Column(Integer, nullable=False, default=0)
    # Изчакване, а не блокиране: детето, което е сгрешило кода, трябва да може да
    # влезе пак след малко, без да пише на никого.
    locked_until = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=_now)


class VerificationCode(Base):
    __tablename__ = "verification_codes"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    purpose = Column(Enum(CodePurpose), nullable=False)
    code_hash = Column(String, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)
