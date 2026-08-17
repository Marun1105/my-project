# test_migration.py — добавянето на users.role върху ВЕЧЕ СЪЩЕСТВУВАЩА база.
#
# Това е тестът, който пази Render: локално базата е нова и колоната се създава
# от create_all, така че счупването не би се видяло до самото качване. Тук нарочно
# правим стара таблица users без role, пълним я с акаунт и чак тогава мигрираме.
#
# Важно: тестът НЕ пипа общата база на другите тестове. db.py прави engine веднъж
# при внасяне, а pytest внася всички модули в един процес — ако тук изтривахме
# таблицата users от общия engine, щяхме да съборим test_smoke.py според реда на
# внасяне. Затова тук има собствен engine, подменен само за времето на теста.
import os
import tempfile

import pytest
from sqlalchemy import create_engine, text

import migrations

_tmp_db = os.path.join(tempfile.mkdtemp(), "old_schema.db")

OLD_USERS_TABLE = """
CREATE TABLE users (
    id VARCHAR PRIMARY KEY,
    display_name VARCHAR NOT NULL,
    email VARCHAR NOT NULL UNIQUE,
    phone VARCHAR,
    password_hash VARCHAR NOT NULL,
    is_email_verified BOOLEAN NOT NULL DEFAULT 0,
    is_phone_verified BOOLEAN NOT NULL DEFAULT 0,
    created_at DATETIME
)
"""


@pytest.fixture
def old_engine(monkeypatch):
    engine = create_engine(f"sqlite:///{_tmp_db}")
    monkeypatch.setattr(migrations, "engine", engine)
    yield engine
    engine.dispose()


def _make_old_schema(engine):
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS users"))
        conn.execute(text(OLD_USERS_TABLE))
        conn.execute(text(
            "INSERT INTO users (id, display_name, email, password_hash, "
            "is_email_verified, is_phone_verified) "
            "VALUES ('u1', 'Стар акаунт', 'old@example.com', 'hash', 1, 0)"
        ))


def test_migration_adds_role_to_an_existing_table(old_engine):
    _make_old_schema(old_engine)
    assert "users.role" in migrations.run()

    with old_engine.begin() as conn:
        role = conn.execute(text("SELECT role FROM users WHERE id = 'u1'")).scalar()
    # никой не бива да загуби достъпа си: заварените акаунти стават ученици
    assert role == "student"


def test_migration_is_idempotent(old_engine):
    _make_old_schema(old_engine)
    assert migrations.run() == ["users.role"]
    # второто пускане (всяко следващо стартиране на сървъра) не бива да прави нищо
    assert migrations.run() == []


def test_migration_is_safe_when_the_table_does_not_exist_yet(old_engine):
    with old_engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS users"))
    # нова, празна база: create_all ще направи таблицата с колоната, тук няма работа
    assert migrations.run() == []
