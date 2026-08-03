# security.py — хеширане на пароли, JWT сесии, кодове за потвърждение
import os
import random
import string
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

JWT_SECRET = os.environ.get("JWT_SECRET") or "dev-secret-change-me"
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
