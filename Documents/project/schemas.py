# schemas.py — формите на заявките и отговорите за auth/задачи
import re
from datetime import date, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, EmailStr, ConfigDict, Field, field_validator


# Горната граница не е каприз: passlib отказва вход над 4096 байта с изключение,
# което не се хваща никъде и излиза като 500 вместо като "паролата е твърде дълга".
# bcrypt и без това гледа само първите 72 байта, така че 128 не ограничава никого.
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.]{3,20}$")
# Свободен формат нарочно: български номера се пишат и като 0888..., и като
# +359888..., и с интервали. Махаме украсата и искаме само да е правдоподобно.
PHONE_RE = re.compile(r"^\+?\d{6,15}$")


def _check_username(v):
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None  # празно поле не е избор на име
    if not USERNAME_RE.match(v):
        raise ValueError("Потребителското име може да е 3-20 знака: букви, цифри, _ и .")
    return v


def _check_phone(v):
    if v is None:
        return None
    v = "".join(ch for ch in v if not ch.isspace() and ch not in "()-")
    if not v:
        return None
    if not PHONE_RE.match(v):
        raise ValueError("Телефонният номер не изглежда валиден.")
    return v


def _check_password_length(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Паролата трябва да е поне 8 символа")
    if len(v) > 128:
        raise ValueError("Паролата е твърде дълга")
    return v


# Затворен списък: свободният текст тук не става за нищо после, а и не искаме
# да пазим каквото ученик реши да напише.
HEARD_FROM = {"friend", "teacher", "parent", "school", "social", "search", "other"}


def _check_heard_from(v):
    if v is None or not str(v).strip():
        return None
    v = str(v).strip().lower()
    if v not in HEARD_FROM:
        raise ValueError("Непознат отговор за произход.")
    return v


class RegisterRequest(BaseModel):
    display_name: str = Field(max_length=80)
    username: Optional[str] = Field(default=None, max_length=20)
    email: EmailStr
    phone: Optional[str] = Field(default=None, max_length=32)
    password: str

    heard_from: Optional[str] = Field(default=None, max_length=20)

    _clean_username = field_validator("username")(_check_username)
    _clean_phone = field_validator("phone")(_check_phone)
    _clean_heard = field_validator("heard_from")(_check_heard_from)
    # По подразбиране "ученик": така стар клиент, който още не праща роля,
    # продължава да работи и създава точно каквото е създавал досега.
    role: Literal["student", "parent", "teacher"] = "student"

    _check_password = field_validator("password")(_check_password_length)


class VerifyEmailRequest(BaseModel):
    email: EmailStr
    code: str = Field(max_length=12)


class ResendCodeRequest(BaseModel):
    email: EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
    # Не е политика за парола, а предпазител: passlib хвърля над 4096 байта и
    # входът връща 500 вместо "грешна парола".
    password: str = Field(max_length=1024)


class ForgotPasswordRequest(BaseModel):
    channel: str = Field(max_length=10)  # "email" или "sms"
    contact: str = Field(max_length=254)  # имейл или телефон, според channel


class ResetPasswordRequest(BaseModel):
    channel: str = Field(max_length=10)
    contact: str = Field(max_length=254)
    code: str = Field(max_length=12)
    new_password: str

    _check_password = field_validator("new_password")(_check_password_length)


class AddPhoneRequest(BaseModel):
    phone: str = Field(max_length=32)


class VerifyPhoneRequest(BaseModel):
    code: str = Field(max_length=12)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    display_name: str
    username: Optional[str] = None
    email: str
    role: str
    phone: Optional[str] = None
    is_email_verified: bool
    is_phone_verified: bool


class AuthResponse(BaseModel):
    token: str
    user: UserOut


# Един ред от чеклиста, не съчинение: и най-дългото домашно се събира в няколко реда,
# а без таван едно вписване побира мегабайти и ги пише в базата на Render. Числата са
# същите като в planner.TaskIn (500/100) с широк запас нагоре, за да не се разминават
# двата пътя, по които една и съща задача влиза в приложението.
TASK_TEXT_MAX = 2000
TASK_SUBJECT_MAX = 100


def _reject_explicit_null(v):
    # model_dump(exclude_unset=True) НЕ различава "полето липсва" от "полето е
    # изрично null" — второто минава нататък и опитва да запише NULL в NOT NULL
    # колона, което излиза като 500 от db.commit(). Тук се спира като 422.
    # Полетата, които наистина могат да се изчистват (subject, deadline), нямат
    # тази проверка и продължават да приемат null.
    if v is None:
        raise ValueError("Полето не може да е празно.")
    return v


class TaskIn(BaseModel):
    text: str = Field(max_length=TASK_TEXT_MAX)
    subject: Optional[str] = Field(default=None, max_length=TASK_SUBJECT_MAX)
    deadline: Optional[date] = None


class TaskUpdate(BaseModel):
    text: Optional[str] = Field(default=None, max_length=TASK_TEXT_MAX)
    subject: Optional[str] = Field(default=None, max_length=TASK_SUBJECT_MAX)
    deadline: Optional[date] = None
    done: Optional[bool] = None

    # Optional са само за да се различи "непратено" от "пратено" при частично
    # обновяване — стойността null обаче не е валидна за тези две колони.
    _text_not_null = field_validator("text")(_reject_explicit_null)
    _done_not_null = field_validator("done")(_reject_explicit_null)


class FamilyInviteOut(BaseModel):
    code: str
    expires_at: datetime


class FamilyLinkRequest(BaseModel):
    # Кодът е 6 знака; 32 оставя място за интервали и разкрасяване при преписване,
    # но не и за низ, който да се търси в базата като цял абзац.
    code: str = Field(max_length=32)


class StudentProgressOut(BaseModel):
    """Само обобщени числа — родителят не вижда текста на задачите или въпросите."""
    student_id: str
    display_name: str
    tasks_pending: int
    tasks_done: int
    tasks_overdue: int
    focus_minutes_7d: int
    focus_streak_days: int
    linked_at: datetime


class FocusSessionIn(BaseModel):
    # горна граница = 24 часа: по-дълга "сесия" е грешка или измислица и само
    # би изкривила статистиката, която родителят вижда
    duration_seconds: int = Field(ge=0, le=86400)
    focus_pct: Optional[int] = Field(default=None, ge=0, le=100)


class FocusSessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    duration_seconds: int
    focus_pct: Optional[int] = None
    created_at: datetime


class ScanHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    question: str
    answer: str
    lang: str
    created_at: datetime


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    text: str
    subject: Optional[str] = None
    deadline: Optional[date] = None
    done: bool
    created_at: datetime
    completed_at: Optional[datetime] = None


class ClassroomCreate(BaseModel):
    # Имената на класове са от рода на "7А" или "10Б — математика"; 60 знака стигат
    # с много запас и на най-описателния учител.
    name: str = Field(max_length=60)


class ClassroomJoinRequest(BaseModel):
    code: str = Field(max_length=32)


class ClassroomOut(BaseModel):
    id: str
    name: str
    join_code: str
    student_count: int
    created_at: datetime


class ClassroomWithStudents(ClassroomOut):
    """Учителят вижда същите обобщени числа като родителя — никога текст на задача."""
    students: List[StudentProgressOut]
