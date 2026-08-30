# auth.py — регистрация, вход, потвърждение на имейл/телефон, забравена парола
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import email_service
import rate_limit
import security
import sms_service
from db import get_db
from models import CodeAttempt, CodePurpose, User, VerificationCode
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


def normalize_email(value: str) -> str:
    """Един-единствен вид на имейла за целия слой за вход.

    EmailStr на Pydantic смъква само домейна; локалната част остава както е
    написана. Затова "Ivan@Abv.bg" и "ivan@abv.bg" стигаха до базата като два
    различни низа, а Postgres сравнява текст буква по буква — една пощенска
    кутия се сдобиваше с два акаунта и собственикът ѝ оставаше отвън.
    Нормализацията се прави тук, а не в schemas.py, за да е на едно място за
    всички пътища: запис, търсене и проверка за заетост.
    """
    return (value or "").strip().lower()


def _email_matches(value: str):
    """Условие за търсене по имейл, което не зависи от главните букви.

    Заварените редове в Render може да пазят "Ivan@Abv.bg" отпреди
    нормализацията. Търсене само по смъкнатия вид би заключило точно тези
    хора извън профилите им, затова сравняваме смъкнато и от двете страни.
    Таблицата users е малка, а изразен индекс нарочно НЕ правим: SQLAlchemy не
    успява да отрази функционален индекс и рефлексията после гърми.
    """
    return func.lower(User.email) == normalize_email(value)


def normalize_phone(value: Optional[str]) -> Optional[str]:
    """Един български номер — един запис.

    schemas.py вече маха интервалите и скобите, но "0888123456" и
    "+359888123456" остават два различни низа за базата, макар да звънят на
    един и същ телефон. Свеждаме до международния вид; чуждите номера и
    всичко, което не разпознаваме, оставяме както са дошли.
    """
    if value is None:
        return None
    v = "".join(ch for ch in value if not ch.isspace() and ch not in "()-")
    if not v:
        return None
    if v.startswith("00"):
        v = "+" + v[2:]
    if v.startswith("359") and len(v) == 12:
        v = "+" + v
    elif v.startswith("0") and len(v) == 10:
        v = "+359" + v[1:]
    return v


# Пет сгрешени кода, после петнадесет минути изчакване. Числата са подбрани за
# дете, което бърка: две-три сгрешени цифри не заключват нищо, а и след
# заключването не се иска нищо повече от търпение. За нападател обаче таванът е
# около 20 опита на час срещу милион възможности — тоест няма нападение.
MAX_CODE_ATTEMPTS = 5
CODE_LOCK_MINUTES = 15


def _attempt_row(db: Session, user: User, purpose: CodePurpose) -> CodeAttempt:
    row = (
        db.query(CodeAttempt)
        .filter(CodeAttempt.user_id == user.id, CodeAttempt.purpose == purpose)
        .first()
    )
    if row is None:
        row = CodeAttempt(user_id=user.id, purpose=purpose, failed_count=0)
        db.add(row)
        db.commit()
    return row


def _lock_minutes_left(row: CodeAttempt) -> int:
    if not row.locked_until:
        return 0
    # SQLite връща naive дати, макар да са записани в UTC — същото допускане
    # като при expires_at по-долу.
    until = row.locked_until if row.locked_until.tzinfo else row.locked_until.replace(tzinfo=timezone.utc)
    left = (until - datetime.now(timezone.utc)).total_seconds()
    return max(0, int(left // 60) + 1) if left > 0 else 0


def _token_version_matches(claims: dict, user: User) -> bool:
    """Токен без "tv" НЕ се приема.

    Токените, издадени преди тази промяна, нямат такова поле. Признаването им би
    означавало, че цял месец напред смяната на паролата пак не прекратява нищо —
    тоест поправката щеше да важи чак от октомври нататък, при това точно за
    открадналия токен, а не за собственика. Затова ги отказваме: цената е един
    вход наново за всички, а екранът за вход е на един клик. При незададен
    JWT_SECRET сесиите и без това не преживяват рестарт, така че за повечето
    хора това не е и промяна.
    """
    tv = claims.get("tv")
    if tv is None:
        return False
    return int(tv) == int(user.token_version or 0)


def _phone_taken(db: Session, phone: str, except_user_id: Optional[str] = None) -> bool:
    """Дали номерът вече е ПОТВЪРДЕН от някой друг."""
    q = db.query(User).filter(User.phone == phone, User.is_phone_verified.is_(True))
    if except_user_id:
        q = q.filter(User.id != except_user_id)
    return q.first() is not None


def _issue_code(db: Session, user: User, purpose: CodePurpose) -> str:
    # Старите неизползвани кодове се обезсилват. Иначе всеки нов код добавяше още
    # една валидна възможност за отгатване, а нападател с достатъчно поискани
    # кодове получаваше стотици опита в един и същи петнадесетминутен прозорец.
    # Страничната полза е, че всеки грешен опит вече струва едно bcrypt сравнение,
    # а не по едно за всеки натрупан код.
    (
        db.query(VerificationCode)
        .filter(
            VerificationCode.user_id == user.id,
            VerificationCode.purpose == purpose,
            VerificationCode.used.is_(False),
        )
        .update({VerificationCode.used: True}, synchronize_session=False)
    )
    code = security.generate_code()
    db.add(VerificationCode(
        user_id=user.id,
        purpose=purpose,
        code_hash=security.hash_code(code),
        expires_at=security.code_expiry(),
    ))
    db.commit()
    # Нарочно НЕ нулираме брояча на сгрешените опити: иначе таванът се заобикаля
    # с "поискай нов код" между всеки два опита и цялата защита пада.
    return code


def _consume_code(db: Session, user: User, purpose: CodePurpose, code: str,
                  reveal_lock: bool = False) -> bool:
    """reveal_lock=True само там, където вече знаем КОЙ пита.

    Заключването се брои по акаунт, тоест съществува само за адрес, зад който
    има акаунт. Ако при заключване отговаряхме различно (429 вместо 400), самото
    заключване ставаше справка: пращаш пет грешни кода към чужд адрес и шестият
    отговор ти казва дали този адрес изобщо има профил в Climby. Точно тази
    справка беше затворена при неправилния код и щеше да се отвори наново
    отстрани. Затова навън заключването изглежда като поредния грешен код, а
    текстът горе казва и на сгрешилото дете какво да направи.

    При вход с вече доказана самоличност (потвърждаване на телефон) няма какво
    да се издаде — там честният отговор е по-полезен.
    """
    attempts = _attempt_row(db, user, purpose)
    left = _lock_minutes_left(attempts)
    if left:
        if reveal_lock:
            raise HTTPException(
                429,
                f"Твърде много грешни кодове. Опитай пак след около {left} мин. "
                "и поискай нов код — акаунтът ти си остава твой, само изчакай малко.",
            )
        return False
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
            attempts.failed_count = 0
            attempts.locked_until = None
            attempts.updated_at = now
            db.commit()
            return True

    attempts.failed_count = (attempts.failed_count or 0) + 1
    attempts.updated_at = now
    if attempts.failed_count >= MAX_CODE_ATTEMPTS:
        attempts.locked_until = now + timedelta(minutes=CODE_LOCK_MINUTES)
        # Нулираме брояча заедно със заключването, за да получи човекът пълни пет
        # опита след изчакването, вместо да се заключва отново на първата грешка.
        attempts.failed_count = 0
    db.commit()
    return False


def get_current_user(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> User:
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(401, "Липсва вход. Влез в профила си.")
    claims = security.decode_token_claims(authorization[len(prefix):])
    if not claims or not claims.get("sub"):
        raise HTTPException(401, "Сесията е изтекла. Влез отново.")
    user = db.get(User, claims["sub"])
    if not user or not _token_version_matches(claims, user):
        raise HTTPException(401, "Сесията е изтекла. Влез отново.")
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
    claims = security.decode_token_claims(authorization[len(prefix):])
    if not claims or not claims.get("sub"):
        return None
    user = db.get(User, claims["sub"])
    if user and not _token_version_matches(claims, user):
        return None
    return user


@router.post("/register")
def register(body: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "register", max_calls=5, window_seconds=3600,
                        message="Твърде много опити за регистрация — изчакай малко и опитай пак.")
    email = normalize_email(body.email)
    phone = normalize_phone(body.phone)
    if db.query(User).filter(_email_matches(email)).first():
        raise HTTPException(400, "Вече има акаунт с този имейл. Опитай да влезеш.")
    # Потребителското име е по желание, но щом го има — е уникално.
    if body.username and db.query(User).filter(User.username == body.username).first():
        raise HTTPException(400, "Това потребителско име е заето. Избери друго.")
    # Само ПОТВЪРДЕН номер заема мястото си. Иначе достатъчно беше някой да се
    # регистрира с чужд номер, без да го потвърждава, за да остане собственикът
    # му отвън завинаги.
    if phone and _phone_taken(db, phone):
        raise HTTPException(400, "Този телефон вече е потвърден от друг акаунт.")

    user = User(
        display_name=body.display_name,
        username=body.username,
        email=email,
        phone=phone,
        role=body.role,
        heard_from=body.heard_from,
        password_hash=security.hash_password(body.password),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Проверките отгоре са "виж, после запиши" — между двете няма нищо, което
        # да спре втора едновременна заявка със същия имейл. На Render работят
        # няколко процеса, така че това се случва наистина, а не на теория.
        # Базата отсича правилно; тук само превеждаме отказа ѝ на човешки език,
        # вместо да оставим единия от двамата да види 500.
        db.rollback()
        raise HTTPException(400, "Вече има акаунт с този имейл или потребителско име. "
                                 "Опитай да влезеш или избери друго име.")
    db.refresh(user)

    code = _issue_code(db, user, CodePurpose.verify_email)
    email_service.send_verification_email(user.email, code)
    return {"status": "ok", "message": "Изпратихме ти код за потвърждение по имейл."}


@router.post("/verify-email", response_model=AuthResponse)
def verify_email(body: VerifyEmailRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "verify-email", max_calls=10, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    # Един и същ отговор за непознат адрес, за вече потвърден и за сгрешен код.
    # Досега трите случая се различаваха (404 / 400 / 400 с друг текст) и това
    # беше готов начин да се провери кой адрес има профил в Climby.
    # Съобщението остава полезно: покрива и трите неща, които наистина може да
    # са се объркали, вместо да оставя детето да гадае.
    BAD_CODE = ("Грешен или изтекъл код. Провери имейла, който си написал, "
                "поискай нов код или — ако вече си потвърдил профила си — просто влез. "
                "Ако си опитвал няколко пъти подред, изчакай петнайсетина минути.")
    user = db.query(User).filter(_email_matches(body.email)).first()
    if not user or user.is_email_verified:
        security.verify_code(body.code, security.DUMMY_PASSWORD_HASH)
        raise HTTPException(400, BAD_CODE)
    if not _consume_code(db, user, CodePurpose.verify_email, body.code):
        raise HTTPException(400, BAD_CODE)

    user.is_email_verified = True
    db.commit()
    return AuthResponse(token=security.create_access_token(user.id, user.token_version), user=UserOut.model_validate(user))


@router.post("/resend-code")
def resend_code(body: ResendCodeRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "resend-code", max_calls=5, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    # Отговорът е един и същ, каквото и да намерим: 400 за регистриран адрес и
    # 404 за нерегистриран правеха от този ендпойнт списък на чуждите акаунти.
    # Текстът е условен ("ако има профил"), за да е ясно на детето, което е
    # сгрешило адреса си, защо кодът не идва.
    user = db.query(User).filter(_email_matches(body.email)).first()
    if user and not user.is_email_verified:
        code = _issue_code(db, user, CodePurpose.verify_email)
        email_service.send_verification_email(user.email, code)
    return {"status": "ok", "message": "Ако има непотвърден профил с този имейл, "
                                       "изпратихме нов код. Провери и папката със спам."}


@router.post("/login", response_model=AuthResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    # Позволяваме сгрешена парола много пъти — сгрешава се често — но не и
    # безброй: без лимит паролата на всеки акаунт е въпрос на време и скрипт.
    rate_limit.enforce(request, "login", max_calls=20, window_seconds=900,
                        message="Твърде много опити за вход — изчакай малко и опитай пак.")
    user = db.query(User).filter(_email_matches(body.email)).first()
    # Сравнението се прави ВИНАГИ, дори когато акаунт няма. Иначе непознатият
    # адрес се връщаше за няколко милисекунди, а познатият — за четвърт секунда,
    # и всеки можеше да провери кой имейл има профил, колкото и общо да е
    # написано съобщението.
    if not user:
        security.verify_password(body.password, security.DUMMY_PASSWORD_HASH)
        raise HTTPException(401, "Грешен имейл или парола.")
    if not security.verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Грешен имейл или парола.")
    if not user.is_email_verified:
        raise HTTPException(403, "Потвърди имейла си, преди да влезеш.")
    return AuthResponse(token=security.create_access_token(user.id, user.token_version), user=UserOut.model_validate(user))


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
    phone = normalize_phone(body.phone)
    if not phone:
        raise HTTPException(400, "Телефонният номер не изглежда валиден.")
    if _phone_taken(db, phone, except_user_id=user.id):
        raise HTTPException(400, "Този телефон вече е потвърден от друг акаунт.")
    user.phone = phone
    user.is_phone_verified = False
    db.commit()
    code = _issue_code(db, user, CodePurpose.verify_phone)
    sms_service.send_verification_sms(phone, code)
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
    if not _consume_code(db, user, CodePurpose.verify_phone, body.code, reveal_lock=True):
        raise HTTPException(400, "Грешен или изтекъл код.")
    # Проверката се прави ПАК тук, а не само при добавянето: между двете стъпки
    # някой друг може да е потвърдил същия номер, а потвърден номер е един.
    if _phone_taken(db, user.phone, except_user_id=user.id):
        raise HTTPException(400, "Този телефон вече е потвърден от друг акаунт.")
    user.is_phone_verified = True
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "Този телефон вече е потвърден от друг акаунт.")
    return {"status": "ok"}


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest, request: Request, db: Session = Depends(get_db)):
    rate_limit.enforce(request, "forgot-password", max_calls=5, window_seconds=3600,
                        message="Твърде много опити — изчакай малко и опитай пак.")
    if body.channel == "email":
        user = db.query(User).filter(_email_matches(body.contact)).first()
    elif body.channel == "sms":
        user = db.query(User).filter(User.phone == normalize_phone(body.contact),
                                     User.is_phone_verified.is_(True)).first()
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
        user = db.query(User).filter(_email_matches(body.contact)).first()
    elif body.channel == "sms":
        # Същият филтър като при forgot-password: непотвърден номер не е ничие
        # доказателство за самоличност и не бива да сменя парола.
        user = db.query(User).filter(User.phone == normalize_phone(body.contact),
                                     User.is_phone_verified.is_(True)).first()
    else:
        raise HTTPException(400, "Невалиден начин за връзка.")

    if not user or not _consume_code(db, user, CodePurpose.reset_password, body.code):
        raise HTTPException(400, "Грешен или изтекъл код. Поискай нов, а ако си "
                                 "опитвал няколко пъти подред — изчакай петнайсетина минути.")

    user.password_hash = security.hash_password(body.new_password)
    # Смяната на паролата прекратява и всички стари сесии. Ако някой е влязъл с
    # открадната или просто забравена отворена сесия, тя спира да важи още тук,
    # а не след тридесет дни.
    user.token_version = (user.token_version or 0) + 1
    db.commit()
    return {"status": "ok", "message": "Паролата е сменена. Вече можеш да влезеш с новата парола."}
