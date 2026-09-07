# db.py — връзка към базата данни: PostgreSQL в продукция, SQLite локално
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.environ.get("DATABASE_URL") or "sqlite:///./climby.db"
# Някои доставчици (Render, Heroku) дават адреса като "postgres://",
# а SQLAlchemy иска "postgresql://"
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)


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
