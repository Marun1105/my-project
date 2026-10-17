# db.py — връзка към базата данни: PostgreSQL в продукция, SQLite локално
import os

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.environ.get("DATABASE_URL") or "sqlite:///./climby.db"
# Някои доставчици (Render, Heroku) дават адреса като "postgres://",
# а SQLAlchemy иска "postgresql://"
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
# Neon hands out its address as "postgresql+psycopg://" — the psycopg 3 driver —
# and requirements.txt installs psycopg2-binary. With that address the server
# died at import with "ModuleNotFoundError: No module named 'psycopg'", every
# deploy since late September, while Render kept serving the last build that
# had booted. Any Postgres address is pointed at the driver that is installed.
# Every spelling of it: postgres or postgresql, with psycopg, psycopg3, or none.
_scheme, _sep, _rest = DATABASE_URL.partition("://")
if _sep and _scheme.lower().split("+")[0] in ("postgres", "postgresql")         and _scheme.lower() != "postgresql+psycopg2":
    DATABASE_URL = "postgresql+psycopg2://" + _rest


def _require_postgres_tls(url: str) -> str:
    """Require TLS for remote database connections; local SQLite is unchanged."""
    parsed = make_url(url)
    if not parsed.drivername.startswith("postgresql"):
        return url
    if (parsed.host or "").lower() in {"", "localhost", "127.0.0.1", "::1"}:
        return url
    sslmode = parsed.query.get("sslmode", "").lower()
    if sslmode in {"require", "verify-ca", "verify-full"}:
        return url
    return parsed.set(query={**parsed.query, "sslmode": "require"}).render_as_string(
        hide_password=False
    )


DATABASE_URL = _require_postgres_tls(DATABASE_URL)


def _engine_kwargs(url: str) -> dict:
    """Настройките на връзката. Отделно от create_engine, за да е проверимо."""
    if url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}}

    return {
        # Съвременните безсървърни бази (Neon, Supabase, Render след сън)
        # приспиват машината след няколко минути покой и затварят връзките.
        # SQLAlchemy не знае това и подава мъртва връзка на следващата заявка:
        # човекът получава 500 при първото си отваряне за деня, а второто мине.
        # pre_ping струва един "SELECT 1" и премахва целия този клас грешки.
        "pool_pre_ping": True,
        # Не държим връзка повече от пет минути. Дотогава отсрещната страна
        # почти сигурно вече я е затворила.
        "pool_recycle": 300,
        "connect_args": {
            # Без срок тук недостъпната база НЕ дава грешка — увисва. А понеже
            # migrations.py се пуска при внасяне на модула, увисва целият старт:
            # портът никога не се отваря и хостингът показва "no open ports
            # detected" без нито един ред обяснение. Точно това се случи, когато
            # безплатната база изтече на 2026-09-03. Десет секунди и ясен
            # traceback са по-добри от мълчаливо чакане.
            "connect_timeout": 10,
        },
    }


engine = create_engine(DATABASE_URL, **_engine_kwargs(DATABASE_URL))
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
