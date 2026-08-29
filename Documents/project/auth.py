# auth.py — регистрация, вход, потвърждение на имейл/телефон, забравена парола
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

import email_service
import rate_limit
import security
import sms_service
from db import get_db
from models import CodePurpose, User, VerificationCode
from schemas import (
    AddPhoneRequest,
    AuthResponse,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResendCodeRequest,
    ResetPasswordRequest,
    UserOut,
    VerifyEmailRequest,
    VerifyPhoneRequest,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _issue_code(db: Session, user: User, purpose: CodePurpose) -> str:
    code = security.generate_code()
    db.add(VerificationCode(
        user_id=user.id,
        purpose=purpose,
        code_hash=security.hash_code(code),
        expires_at=security.code_expiry(),
    ))
    db.commit()
    return code


def _consume_code(db: Session, user: User, purpose: CodePurpose, code: str) -> bool:
    candidates = (
        db.query(VerificationCode)
        .filter(
            VerificationCode.user_id == user.id,
            VerificationCode.purpose == purpose,
            VerificationCode.used.is_(False),
        )
        .order_by(VerificationCode.created_at.desc())
        .all()
    )
    now = datetime.now(timezone.utc)
    for c in candidates:
        # SQLite не пази часова зона — expires_at се връща naive, макар да е записан в UTC
        expires_at = c.expires_at if c.expires_at.tzinfo else c.expires_at.replace(tzinfo=timezone.utc)
        if expires_at < now:
            continue
        if security.verify_code(code, c.code_hash):
            c.used = True
            db.commit()
            return True
    return False


def get_current_user(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(401, "Липсва вход. Влез в профила си.")
    user_id = security.decode_access_token(authorization[len(prefix):])
    if not user_id:
        raise HTTPException(401, "Сесията е изтекла. Влез отново.")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(401, "Потребителят не е намерен.")
    return user


def get_current_user_optional(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> Optional[User]:
    # За ендпойнти, достъпни и за гости (напр. /ask), но които пазят история само
    # ако клиентът все пак е влязъл — не хвърля грешка, просто връща None.
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return None
    user_id = security.decode_access_token(authorization[len(prefix):])
    if not user_id:
        return None
    return db.get(User, user_id)


@router.post("/register")
def register(body: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "register", max_calls=5, window_seconds=3600,
                        message="Твърде много опити за регистрация — изчакай малко и опитай пак.")
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(400, "Вече има акаунт с този имейл. Опитай да влезеш.")
    # Потребителското име и телефонът са по желание, но щом ги има — са уникални.
    if body.username and db.query(User).filter(User.username == body.username).first():
        raise HTTPException(400, "Това потребителско име е заето. Избери друго.")
    if body.phone and db.query(User).filter(User.phone == body.phone).first():
        raise HTTPException(400, "Този телефон вече е използван от друг акаунт.")

    user = User(
        display_name=body.display_name,
        username=body.username,
        email=body.email,
        phone=body.phone,
        role=body.role,
        heard_from=body.heard_from,
        password_hash=security.hash_password(body.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    code = _issue_code(db, user, CodePurpose.verify_email)
    email_service.send_verification_email(user.email, code)
    return {"status": "ok", "message": "Изпратихме ти код за потвърждение по имейл."}


@router.post("/verify-email", response_model=AuthResponse)
def verify_email(body: VerifyEmailRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "verify-email", max_calls=10, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    user = db.query(User).filter(User.email == body.email).first()
    if not user:
        raise HTTPException(404, "Няма акаунт с този имейл.")
    if user.is_email_verified:
        raise HTTPException(400, "Имейлът вече е потвърден.")
    if not _consume_code(db, user, CodePurpose.verify_email, body.code):
        raise HTTPException(400, "Грешен или изтекъл код. Провери имейла си или поискай нов код.")

    user.is_email_verified = True
    db.commit()
    return AuthResponse(token=security.create_access_token(user.id), user=UserOut.model_validate(user))


@router.post("/resend-code")
def resend_code(body: ResendCodeRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "resend-code", max_calls=5, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    user = db.query(User).filter(User.email == body.email).first()
    if not user:
        raise HTTPException(404, "Няма акаунт с този имейл.")
    if user.is_email_verified:
        raise HTTPException(400, "Имейлът вече е потвърден.")
    code = _issue_code(db, user, CodePurpose.verify_email)
    email_service.send_verification_email(user.email, code)
    return {"status": "ok"}


@router.post("/login", response_model=AuthResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    # Позволяваме сгрешена парола много пъти — сгрешава се често — но не и
    # безброй: без лимит паролата на всеки акаунт е въпрос на време и скрипт.
    rate_limit.enforce(request, "login", max_calls=20, window_seconds=900,
                        message="Твърде много опити за вход — изчакай малко и опитай пак.")
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not security.verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Грешен имейл или парола.")
    if not user.is_email_verified:
        raise HTTPException(403, "Потвърди имейла си, преди да влезеш.")
    return AuthResponse(token=security.create_access_token(user.id), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.model_validate(user)


@router.post("/phone")
def add_phone(
    body: AddPhoneRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rate_limit.enforce(request, "add-phone", max_calls=5, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    existing = db.query(User).filter(User.phone == body.phone, User.id != user.id).first()
    if existing:
        raise HTTPException(400, "Този телефон вече е използван от друг акаунт.")
    user.phone = body.phone
    user.is_phone_verified = False
    db.commit()
    code = _issue_code(db, user, CodePurpose.verify_phone)
    sms_service.send_verification_sms(body.phone, code)
    return {"status": "ok", "message": "Изпратихме ти код по SMS."}


@router.post("/verify-phone")
def verify_phone(
    body: VerifyPhoneRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rate_limit.enforce(request, "verify-phone", max_calls=10, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    if not user.phone:
        raise HTTPException(400, "Първо добави телефонен номер.")
    if not _consume_code(db, user, CodePurpose.verify_phone, body.code):
        raise HTTPException(400, "Грешен или изтекъл код.")
    user.is_phone_verified = True
    db.commit()
    return {"status": "ok"}


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "forgot-password", max_calls=5, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    if body.channel == "email":
        user = db.query(User).filter(User.email == body.contact).first()
    elif body.channel == "sms":
        user = db.query(User).filter(User.phone == body.contact, User.is_phone_verified.is_(True)).first()
    else:
        raise HTTPException(400, "Невалиден начин за връзка.")

    # Не издаваме дали акаунтът съществува — винаги отговаряме успешно.
    if user:
        code = _issue_code(db, user, CodePurpose.reset_password)
        if body.channel == "email":
            email_service.send_reset_email(user.email, code)
        else:
            sms_service.send_reset_sms(user.phone, code)
    return {"status": "ok", "message": "Ако акаунтът съществува, изпратихме код."}


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)):
    # Кодът е 6 цифри и живее 15 минути. Без лимит той се познава с изчакване и
    # скрипт, а познатият код сменя паролата — тоест взима акаунта.
    rate_limit.enforce(request, "reset-password", max_calls=10, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    if body.channel == "email":
        user = db.query(User).filter(User.email == body.contact).first()
    elif body.channel == "sms":
        user = db.query(User).filter(User.phone == body.contact).first()
    else:
        raise HTTPException(400, "Невалиден начин за връзка.")

    if not user or not _consume_code(db, user, CodePurpose.reset_password, body.code):
        raise HTTPException(400, "Грешен или изтекъл код.")

    user.password_hash = security.hash_password(body.new_password)
    db.commit()
    return {"status": "ok", "message": "Паролата е сменена. Вече можеш да влезеш с новата парола."}
