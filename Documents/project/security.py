# security.py — хеширане на пароли, JWT сесии, кодове за потвърждение
import os
import random
import secrets
import string
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Без зададен JWT_SECRET НЕ ползваме фиксирана стойност по подразбиране: тя стои в
# публичното repo, а всеки, който я знае, може да си направи валиден токен за чужд
# акаунт. Вместо това вдигаме случаен ключ за текущия процес — сесиите изтичат при
# рестарт (малко неудобство), но никой не може да ги подправи.
JWT_SECRET = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    JWT_SECRET = secrets.token_urlsafe(48)
    print(
        "[security] ВНИМАНИЕ: JWT_SECRET не е зададен — ползвам временен случаен ключ. "
        "Всички сесии ще изтекат при рестарт. Задай JWT_SECRET в средата (Render → Environment).",
        file=sys.stderr,
    )
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 30

CODE_TTL_MINUTES = 15


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def generate_code() -> str:
    return "".join(random.choices(string.digits, k=6))


def hash_code(code: str) -> str:
    return pwd_context.hash(code)


def verify_code(code: str, code_hash: str) -> bool:
    return pwd_context.verify(code, code_hash)


def code_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MINUTES)


def create_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None
