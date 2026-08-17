# schemas.py — формите на заявките и отговорите за auth/задачи
from datetime import date, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, EmailStr, ConfigDict, Field, field_validator


def _check_password_length(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Паролата трябва да е поне 8 символа")
    return v


class RegisterRequest(BaseModel):
    display_name: str
    email: EmailStr
    password: str
    # По подразбиране "ученик": така стар клиент, който още не праща роля,
    # продължава да работи и създава точно каквото е създавал досега.
    role: Literal["student", "parent", "teacher"] = "student"

    _check_password = field_validator("password")(_check_password_length)


class VerifyEmailRequest(BaseModel):
    email: EmailStr
    code: str


class ResendCodeRequest(BaseModel):
    email: EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ForgotPasswordRequest(BaseModel):
    channel: str  # "email" или "sms"
    contact: str  # имейл или телефон, според channel


class ResetPasswordRequest(BaseModel):
    channel: str
    contact: str
    code: str
    new_password: str

    _check_password = field_validator("new_password")(_check_password_length)


class AddPhoneRequest(BaseModel):
    phone: str


class VerifyPhoneRequest(BaseModel):
    code: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    display_name: str
    email: str
    role: str
    phone: Optional[str] = None
    is_email_verified: bool
    is_phone_verified: bool


class AuthResponse(BaseModel):
    token: str
    user: UserOut


class TaskIn(BaseModel):
    text: str
    subject: Optional[str] = None
    deadline: Optional[date] = None


class TaskUpdate(BaseModel):
    text: Optional[str] = None
    subject: Optional[str] = None
    deadline: Optional[date] = None
    done: Optional[bool] = None


class FamilyInviteOut(BaseModel):
    code: str
    expires_at: datetime


class FamilyLinkRequest(BaseModel):
    code: str


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
    name: str


class ClassroomJoinRequest(BaseModel):
    code: str


class ClassroomOut(BaseModel):
    id: str
    name: str
    join_code: str
    student_count: int
    created_at: datetime


class ClassroomWithStudents(ClassroomOut):
    """Учителят вижда същите обобщени числа като родителя — никога текст на задача."""
    students: List[StudentProgressOut]
