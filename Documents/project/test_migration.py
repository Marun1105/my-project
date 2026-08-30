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
from sqlalchemy import create_engine, inspect, text

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
    first = migrations.run()
    # Проверката е за идемпотентност, не за конкретния списък — иначе всяка нова
    # миграция чупи теста, без нищо да се е счупило.
    assert "users.role" in first
    # второто пускане (всяко следващо стартиране на сървъра) не бива да прави нищо
    assert migrations.run() == []


def test_migration_adds_username_without_touching_existing_accounts(old_engine):
    _make_old_schema(old_engine)
    applied = migrations.run()
    assert "users.username" in applied

    with old_engine.begin() as conn:
        # заварен акаунт остава без потребителско име, вместо да получи чуждо
        assert conn.execute(text("SELECT username FROM users WHERE id = 'u1'")).scalar() is None
        # а две празни имена не се бият в уникалния индекс
        conn.execute(text(
            "INSERT INTO users (id, display_name, email, password_hash, is_email_verified, is_phone_verified) "
            "VALUES ('u2', 'Втори', 'two@example.com', 'hash', 1, 0)"
        ))
        assert conn.execute(text("SELECT COUNT(*) FROM users WHERE username IS NULL")).scalar() == 2


def test_migration_is_safe_when_the_table_does_not_exist_yet(old_engine):
    with old_engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS users"))
    # нова, празна база: create_all ще направи таблицата с колоната, тук няма работа
    assert migrations.run() == []


POPULATED_USERS = """
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

# Няколко истински на вид акаунта, включително двата случая, които могат да
# спънат миграцията: имейл с главни букви и двойка, която се бие след смъкването.
POPULATED_ROWS = [
    ("u1", "Иван", "ivan@example.com", "+359888000001"),
    ("u2", "Мария", "Maria@Example.com", "+359888000002"),
    ("u3", "Петър", "petar@example.com", None),
    ("u4", "Георги", "Georgi@Example.com", "+359888000004"),
    ("u5", "Ана", "ana@example.com", "+359888000005"),
]


def _make_populated_schema(engine, unique_phone=True):
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS users"))
        conn.execute(text(POPULATED_USERS))
        kind = "UNIQUE INDEX" if unique_phone else "INDEX"
        conn.execute(text(f"CREATE {kind} ix_users_phone ON users (phone)"))
        for uid, name, email, phone in POPULATED_ROWS:
            conn.execute(
                text("INSERT INTO users (id, display_name, email, phone, password_hash, "
                     "is_email_verified, is_phone_verified) "
                     "VALUES (:id, :n, :e, :p, 'hash', 1, 0)"),
                {"id": uid, "n": name, "e": email, "p": phone},
            )


def test_migration_gives_every_existing_account_a_token_version(old_engine):
    # Колоната идва върху ПЪЛНА таблица — точно случаят на Render. Никой акаунт
    # не бива да изчезне и никой не бива да остане без стойност, защото токен
    # без съвпадаща версия значи изхвърлен потребител.
    _make_populated_schema(old_engine)
    assert "users.token_version" in migrations.run()

    with old_engine.begin() as conn:
        rows = conn.execute(text(
            "SELECT id, token_version FROM users ORDER BY id"
        )).fetchall()
    assert [r[0] for r in rows] == [r[0] for r in POPULATED_ROWS]
    assert all(r[1] == 0 for r in rows), "всеки заварен акаунт тръгва от версия 0"

    # второто стартиране на сървъра не прави нищо
    assert migrations.run() == []


def test_migration_drops_the_unique_index_on_phone(old_engine):
    # Уникалният индекс превръщаше непотвърдена претенция за номер в блокада
    # срещу истинския му собственик.
    _make_populated_schema(old_engine, unique_phone=True)
    assert "users.phone:drop-unique" in migrations.run()

    inspector = inspect(old_engine)
    phone_index = next(i for i in inspector.get_indexes("users") if i["name"] == "ix_users_phone")
    assert not phone_index["unique"], "индексът остава, но вече не е уникален"

    # два непотвърдени еднакви номера вече не се бият
    with old_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO users (id, display_name, email, phone, password_hash, "
            "is_email_verified, is_phone_verified) "
            "VALUES ('u6', 'Нов', 'nov@example.com', '+359888000001', 'hash', 1, 0)"
        ))
    assert migrations.run() == []


def test_migration_lowercases_emails_and_leaves_collisions_alone(old_engine):
    _make_populated_schema(old_engine)
    # Дефектът, който поправяме, е позволявал точно това: една пощенска кутия,
    # два реда. Смъкването на "Ana@Example.com" би ударило вече съществуващия
    # "ana@example.com" и би съборило стартирането — затова се прескача.
    with old_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO users (id, display_name, email, password_hash, "
            "is_email_verified, is_phone_verified) "
            "VALUES ('u7', 'Двойник', 'Ana@Example.com', 'hash', 1, 0)"
        ))

    applied = migrations.run()
    assert any(a.startswith("users.email:lower") for a in applied), applied

    with old_engine.begin() as conn:
        emails = dict(conn.execute(text("SELECT id, email FROM users")).fetchall())
    # безопасните редове са подредени
    assert emails["u2"] == "maria@example.com"
    assert emails["u4"] == "georgi@example.com"
    # а сблъскващият се е оставен непокътнат, за да го разгледа човек
    assert emails["u7"] == "Ana@Example.com"
    assert emails["u5"] == "ana@example.com"
    # и никой не е изчезнал
    assert len(emails) == len(POPULATED_ROWS) + 1

    # второто пускане пак не пипа нищо ново
    assert migrations.run() == []
