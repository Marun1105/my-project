# security.py — хеширане на пароли, JWT сесии, кодове за потвърждение
import os
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
    if os.environ.get("DATABASE_URL"):
        # DATABASE_URL значи, че това не е нечия локална машина, а истинският
        # сървър — там ключът е случаен ЗА ВСЕКИ ПРОЦЕС поотделно. Render пуска
        # повече от един работник, така че токен, издаден от единия, се отхвърля
        # от другия и децата изхвърчат от профилите си без причина и без
        # закономерност: обновяват страницата и понякога са влезли, понякога не.
        _banner = "!" * 78
        for _line in (
            "",
            _banner,
            "[security] JWT_SECRET ЛИПСВА В ПРОДУКЦИОННА СРЕДА (открит е DATABASE_URL).",
            "[security] Всеки работен процес вдига СВОЙ случаен ключ, затова входовете",
            "[security] ще се разпадат на случаен принцип между процесите, а всяко",
            "[security] стартиране ще изхвърля всички навън.",
            "[security] Поправка: Render → Environment → JWT_SECRET = дълъг случаен низ",
            "[security] (напр. python -c \"import secrets; print(secrets.token_urlsafe(48))\"),",
            "[security] след което рестарт на услугата.",
            _banner,
            "",
        ):
            print(_line, file=sys.stderr)
        # Нарочно предупреждение, а не спиране: никой още не е потвърдил, че
        # променливата е зададена на живата услуга, а спиране при стартиране би
        # свалило приложението на следващото качване — за истински хора, заради
        # настройка, която може вече да е наред. След като собственикът потвърди,
        # че JWT_SECRET съществува в Render, редът по-долу се разкоментира и
        # липсващият ключ става грешка още при стартиране:
        # raise RuntimeError("JWT_SECRET липсва — задай го в Render → Environment.")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 30

CODE_TTL_MINUTES = 15


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


# Хеш на случайна парола, която никой не знае и никога няма да бъде позната.
# Служи само за да има какво да сравнява входът, когато такъв акаунт няма:
# bcrypt е бавен нарочно и точно тази бавност издаваше кои адреси са
# регистрирани — с акаунт отговорът идваше за ~250 мс, без акаунт за ~5 мс.
# Сега и двата пътя минават през едно и също сравнение.
DUMMY_PASSWORD_HASH = pwd_context.hash(secrets.token_urlsafe(32))


def generate_code() -> str:
    # secrets, не random: тези кодове потвърждават имейл и сменят парола. random е
    # Mersenne Twister — предвидим е, ако някой събере достатъчно негови изходи,
    # което тук би означавало превземане на чужд акаунт.
    return "".join(secrets.choice(string.digits) for _ in range(6))


def hash_code(code: str) -> str:
    return pwd_context.hash(code)


def verify_code(code: str, code_hash: str) -> bool:
    return pwd_context.verify(code, code_hash)


def code_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MINUTES)


def create_access_token(user_id: str, token_version: int = 0) -> str:
    # "tv" е версията на сесиите за този акаунт. Токенът важи, само докато
    # съвпада с users.token_version — смяната на паролата вдига числото и с това
    # прекратява всички стари сесии. Без него откраднат токен си работеше още
    # тридесет дни, каквото и да прави собственикът на акаунта.
    payload = {
        "sub": user_id,
        "tv": int(token_version or 0),
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token_claims(token: str) -> Optional[dict]:
    """Връща целия payload, а не само "sub".

    Функцията нарочно е с ново име. Предишният ѝ вид връщаше идентификатора на
    потребителя и се подаваше право на db.get(User, ...); ако беше сменена само
    стойността, всяко невнимателно останало извикване щеше да продължи да се
    компилира и да се чупи чак по време на работа. С ново име такова извикване
    гърми веднага и на видимо място.
    """
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
