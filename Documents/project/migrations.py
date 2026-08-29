# migrations.py — малки поправки по вече съществуващи таблици.
#
# Base.metadata.create_all() създава липсващи ТАБЛИЦИ, но никога не добавя липсваща
# КОЛОНА към таблица, която вече съществува. Затова добавянето на users.role щеше да
# мине гладко локално (нова, празна база) и да счупи Render, където таблицата users
# вече е пълна с акаунти. Тук колоната се добавя явно и идемпотентно — може да се
# извика при всяко стартиране без вреда.
#
# Това не е Alembic и не се опитва да бъде: проектът има нужда само от "добави
# колона, ако я няма". Ако някой ден потрябват истински миграции, тук е мястото,
# което трябва да се смени.
from sqlalchemy import inspect, text

from db import engine


def _column_exists(table: str, column: str) -> bool:
    inspector = inspect(engine)
    if table not in inspector.get_table_names():
        return True  # таблицата още не е създадена — create_all ще я направи с колоната
    return any(col["name"] == column for col in inspector.get_columns(table))


def _add_column(table: str, column: str, ddl_type: str, default_sql: str) -> bool:
    if _column_exists(table, column):
        return False
    with engine.begin() as conn:
        conn.execute(text(
            f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type} NOT NULL DEFAULT {default_sql}"
        ))
    return True


def _add_nullable_column(table: str, column: str, ddl_type: str) -> bool:
    """За колони по желание. NOT NULL DEFAULT не върши работа тук: стойност по
    подразбиране върху уникална колона би направила всички стари редове еднакви."""
    if _column_exists(table, column):
        return False
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))
    return True


def _create_unique_index(table: str, column: str, name: str) -> bool:
    inspector = inspect(engine)
    if table not in inspector.get_table_names():
        return False
    if any(i["name"] == name for i in inspector.get_indexes(table)):
        return False
    # IF NOT EXISTS го има и в SQLite, и в Postgres — не гърми при второ пускане.
    with engine.begin() as conn:
        conn.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS {name} ON {table} ({column})"))
    return True


def run() -> list:
    """Връща имената на приложените промени — полезно в логовете на Render."""
    applied = []
    # Съществуващите акаунти стават "ученик": това е ролята, с която всички са
    # използвали приложението досега, така че никой не губи достъп до нищо.
    if _add_column("users", "role", "VARCHAR", "'student'"):
        applied.append("users.role")
    # Потребителското име идва по-късно от акаунтите — старите остават без него,
    # докато собственикът им не си го избере.
    if _add_nullable_column("users", "username", "VARCHAR"):
        applied.append("users.username")
    if _create_unique_index("users", "username", "ix_users_username"):
        applied.append("ix_users_username")
    return applied
