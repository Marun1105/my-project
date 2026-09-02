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
from sqlalchemy.exc import IntegrityError

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


def test_migration_canonicalises_phones_and_protects_the_real_owner(old_engine):
    """Заварен потвърден номер в стария изписване не бива да губи собственика си.

    Дефектът: новите записи минаваха през normalize_phone, старите не. Тоест
    "0888123456" в базата и "+359888123456" от клавиатурата бяха един апарат и
    два различни низа — и понеже уникалността върху phone беше свалена, някой
    друг можеше да запише международния вид, да го потвърди със СВОЯ SMS и да
    стане вторият потвърден собственик на същия телефон. При "забравена парола"
    по SMS търсенето се свежда до международния вид, а .first() връщаше новия.
    """
    _make_populated_schema(old_engine)
    with old_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO users (id, display_name, email, phone, password_hash, "
            "is_email_verified, is_phone_verified) "
            "VALUES ('u8', 'Собственик', 'owner@example.com', '0888123456', "
            "'hash', 1, 1)"
        ))

    applied = migrations.run()
    assert any(a.startswith("users.phone:canonical") for a in applied), applied
    assert "ix_users_phone_verified" in applied, applied

    with old_engine.begin() as conn:
        phone, verified = conn.execute(text(
            "SELECT phone, is_phone_verified FROM users WHERE id = 'u8'"
        )).first()
        # приведен към международния вид, но все така потвърден
        assert phone == "+359888123456"
        assert verified

        # и вече никой втори не може да потвърди същия номер — базата отказва,
        # тоест except IntegrityError в auth.py пак значи нещо
        conn.execute(text(
            "INSERT INTO users (id, display_name, email, password_hash, "
            "is_email_verified, is_phone_verified) "
            "VALUES ('u9', 'Втори', 'second@example.com', 'hash', 1, 0)"
        ))
    with pytest.raises(IntegrityError):
        with old_engine.begin() as conn:
            conn.execute(text(
                "UPDATE users SET phone = '+359888123456', is_phone_verified = 1 "
                "WHERE id = 'u9'"
            ))

    assert migrations.run() == []


def test_unverified_claims_may_share_a_number(old_engine):
    """Уникалността е само върху потвърдените — иначе се връща старият дефект,
    при който първият вписал чужд номер го заключваше за собственика завинаги."""
    _make_populated_schema(old_engine)
    migrations.run()
    with old_engine.begin() as conn:
        for i, uid in enumerate(("p1", "p2")):
            conn.execute(text(
                "INSERT INTO users (id, display_name, email, phone, password_hash, "
                "is_email_verified, is_phone_verified) "
                f"VALUES ('{uid}', 'Заявка', '{uid}@example.com', '+359888999000', "
                "'hash', 1, 0)"
            ))
        both = conn.execute(text(
            "SELECT COUNT(*) FROM users WHERE phone = '+359888999000'"
        )).scalar()
    assert both == 2


OLD_CODE_ATTEMPTS = """
CREATE TABLE code_attempts (
    id VARCHAR PRIMARY KEY,
    user_id VARCHAR NOT NULL,
    purpose VARCHAR NOT NULL,
    failed_count INTEGER NOT NULL DEFAULT 0,
    locked_until DATETIME,
    updated_at DATETIME
)
"""


def _make_old_code_attempts(engine):
    """Таблицата такава, каквато е на Render: създадена от по-стар create_all,
    тоест без уникалността, която моделът вече носи. create_all не пипа заварена
    таблица, така че точно там дефектът остава жив без миграция."""
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS code_attempts"))
        conn.execute(text(OLD_CODE_ATTEMPTS))


def test_migration_makes_the_code_attempt_counter_unique(old_engine):
    """Два брояча за един акаунт и една цел значеха двоен таван на опитите."""
    _make_old_schema(old_engine)
    _make_old_code_attempts(old_engine)
    with old_engine.begin() as conn:
        for i in ("a1", "a2"):
            conn.execute(text(
                "INSERT INTO code_attempts (id, user_id, purpose, failed_count) "
                f"VALUES ('{i}', 'u1', 'reset_password', 2)"
            ))

    assert "uq_code_attempts_user_purpose" in migrations.run()

    with old_engine.begin() as conn:
        rows = conn.execute(text(
            "SELECT failed_count FROM code_attempts WHERE user_id = 'u1'"
        )).fetchall()
    # дублиращите се редове са слети в един — броенето пак е едно
    assert len(rows) == 1
    # взимаме най-голямото от двете, не сбора: излишният ред е наша грешка и не
    # бива да се превърне в заключване върху дете, което не е сгрешило толкова
    assert rows[0][0] == 2

    # и втори ред за същата двойка вече не се приема от базата
    with pytest.raises(IntegrityError):
        with old_engine.begin() as conn:
            conn.execute(text(
                "INSERT INTO code_attempts (id, user_id, purpose, failed_count) "
                "VALUES ('a3', 'u1', 'reset_password', 0)"
            ))

    # различната цел си остава отделен брояч
    with old_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO code_attempts (id, user_id, purpose, failed_count) "
            "VALUES ('a4', 'u1', 'verify_email', 0)"
        ))

    assert migrations.run() == []


def test_a_second_worker_survives_a_step_that_is_already_done(old_engine, monkeypatch):
    """Двама работници, тръгнали заедно, не бива да си убиват единия.

    На Render uvicorn вдига няколко процеса и всеки изпълнява стъпките по схемата
    при внасянето на server.py. Дефектът: проверката "има ли я колоната" и самият
    ALTER не са едно действие: и двамата виждаха липсваща колона, и двамата
    пускаха ALTER TABLE, а загубилият получаваше duplicate column направо във
    внасянето на модула — тоест умираше при вдигане заради нещо, което вече е
    било направено.

    Тук нарочно караме проверката ВИНАГИ да казва "липсва" — така стъпката се
    изпълнява втори път върху вече поправена таблица, точно както при загубена
    надпревара.
    """
    _make_old_schema(old_engine)
    assert "users.role" in migrations.run()

    real = migrations._column_exists
    monkeypatch.setattr(
        migrations, "_column_exists",
        lambda table, column: False if column == "role" else real(table, column),
    )
    # не гърми, макар ALTER-ът да се проваля — колоната е налице, няма какво да се прави
    assert "users.role" not in migrations.run()

    with old_engine.begin() as conn:
        assert conn.execute(text("SELECT role FROM users WHERE id = 'u1'")).scalar() == "student"


def test_the_schema_lock_is_not_required_on_sqlite(old_engine):
    """В SQLite няма pg_advisory_lock и не трябва: процесът е един. Липсата ѝ не
    бива да е грешка, иначе локалната разработка не тръгва изобщо."""
    with migrations.schema_lock():
        pass


def test_the_schema_lock_gives_up_instead_of_waiting_forever(monkeypatch):
    """Заета ключалка не бива да спира вдигането завинаги.

    pg_advisory_lock блокира без срок. Умре ли предишно вдигане, докато я държи,
    следващото спира преди да е отворило порт — а отвън това не изглежда като
    грешка: няма следа, само деплой, който изтича с "no open ports detected".
    Точно това се случи веднъж и остана невидимо, докато не се погледна логът на
    хостинга.
    """
    import time as _time

    calls = {"tries": 0, "slept": 0.0}

    class _FakeResult:
        def scalar(self):
            calls["tries"] += 1
            return False  # ключалката е заета през цялото време

    class _FakeConn:
        closed = False

        def execute(self, *a, **kw):
            return _FakeResult()

        def commit(self):
            pass

        def close(self):
            _FakeConn.closed = True

    monkeypatch.setattr(migrations.engine.dialect, "name", "postgresql", raising=False)
    monkeypatch.setattr(migrations.engine, "connect", lambda: _FakeConn())
    # въртим часовника напред вместо да чакаме наистина
    monkeypatch.setattr(migrations.time, "sleep", lambda s: calls.__setitem__("slept", calls["slept"] + s))
    base = _time.monotonic()
    ticks = iter([base + i * 2.0 for i in range(1, 200)])
    monkeypatch.setattr(migrations.time, "monotonic", lambda: next(ticks))

    entered = False
    with migrations.schema_lock():
        entered = True

    assert entered, "вдигането трябва да продължи, а не да виси на заета ключалка"
    assert calls["tries"] >= 1
    assert calls["slept"] <= migrations.LOCK_WAIT_SECONDS + 1, "чакало е по-дълго от срока"
    assert _FakeConn.closed, "връзката без ключалка трябва да се затвори"


def test_no_boolean_column_is_compared_to_a_number_in_raw_sql():
    """Postgres няма оператор boolean = integer — SQLite има, и точно това крие грешката.

    Тестовете тук вървят върху SQLite, където истината се пази като 1 и
    "is_phone_verified = 1" минава без забележка. На Render същият ред хвърля
    UndefinedFunction, SQLAlchemy го увива в ProgrammingError, а _tolerantly не
    го разпознава като "вече направено" и го препуска нагоре. Резултатът е
    сървър, който не тръгва — и Render мълчаливо остава на предишното качване.
    Затова проверката е върху текста на SQL-а: тя вижда разминаването тук, а не
    след качване.
    """
    import re

    import models  # noqa: F401 - внасянето пълни Base.metadata с таблиците
    from db import Base

    boolean_columns = {
        column.name
        for table in Base.metadata.tables.values()
        for column in table.columns
        if column.type.__class__.__name__ == "Boolean"
    }
    assert boolean_columns, "няма нито една булева колона — проверката би минала празна"

    source = open(migrations.__file__, encoding="utf-8").read()
    offenders = []
    for name in sorted(boolean_columns):
        for match in re.finditer(rf"\b{re.escape(name)}\s*(?:=|<>|!=)\s*[01]\b", source):
            line = source.count("\n", 0, match.start()) + 1
            offenders.append(f"migrations.py:{line}: {match.group(0)}")

    assert not offenders, (
        "булева колона се сравнява с число в суров SQL — на Postgres това не тръгва.\n"
        "Ползвай = TRUE / = FALSE (работи и на двете бази):\n  " + "\n  ".join(offenders)
    )
