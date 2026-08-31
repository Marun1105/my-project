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
import sys

from sqlalchemy import inspect, text

from db import engine


def _table_exists(table: str) -> bool:
    return table in inspect(engine).get_table_names()


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


def _drop_unique_phone_index() -> bool:
    """Сваля уникалността от users.phone, като оставя обикновен индекс.

    Уникалният индекс изглеждаше като защита, а вършеше обратното: пазеше
    непотвърдена претенция за номер точно толкова строго, колкото потвърдена.
    Който пръв впишеше чужд номер, го заключваше за собственика му завинаги.
    Уникалността на потвърдените номера вече се проверява в auth.py.

    Сваляне на индекс не докосва редовете и не може да се спъне в данните —
    затова е безопасно и върху пълната таблица в Render. Второто пускане
    намира индекса вече неуникален и не прави нищо.
    """
    if not _table_exists("users"):
        return False
    inspector = inspect(engine)
    indexes = {i["name"]: i for i in inspector.get_indexes("users")}
    unique_constraints = [
        c["name"] for c in inspector.get_unique_constraints("users")
        if c.get("column_names") == ["phone"] and c.get("name")
    ]
    idx = indexes.get("ix_users_phone")
    if not unique_constraints and (idx is None or not idx.get("unique")):
        return False
    with engine.begin() as conn:
        # Възможно е уникалността да е дошла като ограничение, а не като индекс,
        # ако таблицата е правена от по-стара версия на модела — покриваме и двете.
        for name in unique_constraints:
            conn.execute(text(f"ALTER TABLE users DROP CONSTRAINT IF EXISTS {name}"))
        if idx is not None and idx.get("unique"):
            conn.execute(text("DROP INDEX IF EXISTS ix_users_phone"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_phone ON users (phone)"))
    return True


def _normalize_existing_emails() -> int:
    """Смъква главните букви в заварените имейли — но само където това е безопасно.

    Приложението вече записва и търси имейла смъкнат, така че този backfill не е
    задължителен за работата му; той просто подрежда данните, за да не се налага
    после да се мисли за два вида на един и същ адрес.

    Точно затова обаче се прави ред по ред, а не с едно UPDATE. Старият дефект
    позволяваше едновременно "Ivan@Abv.bg" и "ivan@abv.bg"; сляпо смъкване би
    ударило уникалния индекс, миграцията би гръмнала при стартиране и цялото
    приложение нямаше да се вдигне заради два реда. Ред, който би се сблъскал с
    вече съществуващ, се прескача и се изписва в лога — такъв случай иска човек,
    който да реши кой от двата акаунта е истинският, а не автоматика.
    """
    if not _table_exists("users"):
        return 0
    changed = 0
    with engine.begin() as conn:
        rows = conn.execute(text(
            "SELECT id, email FROM users WHERE email <> lower(email)"
        )).fetchall()
        for row_id, email in rows:
            lowered = email.strip().lower()
            taken = conn.execute(
                text("SELECT id FROM users WHERE lower(email) = :e AND id <> :id"),
                {"e": lowered, "id": row_id},
            ).first()
            if taken:
                print(
                    f"[migrations] ВНИМАНИЕ: {email!r} не е нормализиран — вече има друг "
                    f"акаунт със същия адрес (id={taken[0]}). Двата акаунта трябва да се "
                    "обединят на ръка.",
                    file=sys.stderr,
                )
                continue
            conn.execute(
                text("UPDATE users SET email = :e WHERE id = :id"),
                {"e": lowered, "id": row_id},
            )
            changed += 1
    return changed


def _normalize_existing_phones() -> int:
    """Подрежда заварените телефони към международния вид, ред по ред.

    Без това нормализирането е половинчато и опасно. Новите записи минават през
    auth.normalize_phone, а старите остават както са били въведени — тоест
    "0888123456" в базата и "+359888123456" от клавиатурата са един и същ
    телефон, но два различни низа. А точно по този низ се търси акаунтът при
    възстановяване на паролата по SMS.

    Какво излизаше от това: заварен ред с потвърден "0888123456" не се брои за
    зает, някой друг записва "+359888123456", потвърждава го със СВОЯ SMS и вече
    има два потвърдени реда за един апарат. При "забравена парола" по SMS
    заявката се свежда до международния вид и .first() връща новия акаунт —
    истинският собственик тихо губи възстановяването по телефон.

    Ред, който би се сблъскал с вече потвърден чужд номер, се прескача и се
    изписва в лога: кой от двата акаунта е истинският е човешко решение.
    """
    if not _table_exists("users"):
        return 0
    columns = {col["name"] for col in inspect(engine).get_columns("users")}
    if not {"phone", "is_phone_verified"} <= columns:
        return 0

    from auth import normalize_phone  # локален внос: няма нужда от него при всяко пускане

    changed = 0
    with engine.begin() as conn:
        rows = conn.execute(text(
            "SELECT id, phone, is_phone_verified FROM users WHERE phone IS NOT NULL"
        )).fetchall()
        for row_id, phone, verified in rows:
            canonical = normalize_phone(phone)
            if not canonical or canonical == phone:
                continue
            clash = conn.execute(
                text("SELECT id FROM users WHERE phone = :p AND is_phone_verified = 1 "
                     "AND id <> :id"),
                {"p": canonical, "id": row_id},
            ).first()
            if clash and verified:
                print(
                    f"[migrations] ВНИМАНИЕ: телефонът на акаунт {row_id} не е приведен "
                    f"към {canonical!r} — вече има потвърден акаунт със същия номер "
                    f"(id={clash[0]}). Двата трябва да се разгледат на ръка.",
                    file=sys.stderr,
                )
                continue
            conn.execute(
                text("UPDATE users SET phone = :p WHERE id = :id"),
                {"p": canonical, "id": row_id},
            )
            changed += 1
    return changed


def _create_verified_phone_unique_index() -> bool:
    """Уникалност само върху ПОТВЪРДЕНИТЕ номера.

    Пълната уникалност беше свалена нарочно: докато номерът не е потвърден, той
    не е ничие доказателство и не бива да заключва истинския собственик отвън.
    Но след като е потвърден, той трябва да е един — иначе двама души минават
    проверката "не е зает" едновременно и и двамата записват, а при
    възстановяване по SMS .first() решава кой е собственикът.

    Частичният индекс пази точно това и връща смисъла на except IntegrityError в
    auth.py, който след сваляне на стария индекс беше останал мъртъв код.
    Поддържа се и от SQLite, и от Postgres.
    """
    if not _table_exists("users"):
        return False
    name = "ix_users_phone_verified"
    if any(i["name"] == name for i in inspect(engine).get_indexes("users")):
        return False
    with engine.begin() as conn:
        dupes = conn.execute(text(
            "SELECT phone FROM users WHERE phone IS NOT NULL AND is_phone_verified = 1 "
            "GROUP BY phone HAVING COUNT(*) > 1"
        )).fetchall()
        if dupes:
            # Създаването би гръмнало и сървърът нямаше да тръгне — заради данни,
            # които и без това искат човешко решение. По-добре без индекс и на глас.
            print(
                "[migrations] ВНИМАНИЕ: не създавам ix_users_phone_verified — има "
                f"потвърдени дублирани номера: {[d[0] for d in dupes]}. Оправи ги и "
                "пусни отново.",
                file=sys.stderr,
            )
            return False
        conn.execute(text(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {name} ON users (phone) "
            "WHERE is_phone_verified = 1"
        ))
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
    if _add_nullable_column("users", "heard_from", "VARCHAR"):
        applied.append("users.heard_from")
    # Всички заварени акаунти тръгват от версия 0 — числото важи само спрямо
    # само себе си, така че стойността по подразбиране не ощетява никого.
    if _add_column("users", "token_version", "INTEGER", "0"):
        applied.append("users.token_version")
    if _drop_unique_phone_index():
        applied.append("users.phone:drop-unique")
    # Подреждане на заварените имейли към смъкнатия вид, с който работи auth.py.
    normalized = _normalize_existing_emails()
    if normalized:
        applied.append(f"users.email:lower x{normalized}")
    # Телефоните — същото подреждане, и чак след него уникалността върху
    # потвърдените, за да не се спъне индексът в номер, който още не е приведен.
    phones = _normalize_existing_phones()
    if phones:
        applied.append(f"users.phone:canonical x{phones}")
    if _create_verified_phone_unique_index():
        applied.append("ix_users_phone_verified")
    return applied
