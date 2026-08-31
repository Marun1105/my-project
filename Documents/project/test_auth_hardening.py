# test_auth_hardening.py — тестовете за поправките по вход и потвърждение.
#
# Всеки тест тук описва конкретен начин, по който чужд акаунт можеше да бъде
# взет или блокиран, а не просто "работи ли ендпойнтът". Затова имената им са
# дълги: важното е какво НЕ бива да може да се случи.
#
# Както в test_smoke.py, базата се подменя ОЩЕ преди внасянето на server.py —
# иначе тестовете биха писали в истинския climby.db.
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone

import pytest

_tmp_db = os.path.join(tempfile.mkdtemp(), "hardening.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret-test-secret-test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import jwt  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, text  # noqa: E402

import auth  # noqa: E402
import email_service  # noqa: E402
import rate_limit  # noqa: E402
import security  # noqa: E402
import server  # noqa: E402
import sms_service  # noqa: E402
from db import SessionLocal, engine  # noqa: E402
from models import CodePurpose, User, VerificationCode  # noqa: E402

client = TestClient(server.app)


@pytest.fixture(autouse=True)
def _clear_rate_limits():
    # Лимитът по IP е за истински нападател, не за тестовете — иначе третият
    # тест в реда би падал заради втория.
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


@pytest.fixture
def codes(monkeypatch):
    """Прихваща кодовете, които иначе биха тръгнали по имейл или SMS."""
    sent = []
    monkeypatch.setattr(email_service, "send_verification_email", lambda to, code: sent.append(code))
    monkeypatch.setattr(email_service, "send_reset_email", lambda to, code: sent.append(code))
    monkeypatch.setattr(sms_service, "send_verification_sms", lambda to, code: sent.append(code))
    monkeypatch.setattr(sms_service, "send_reset_sms", lambda to, code: sent.append(code))
    return sent


def _register(email, password="testpass123", **extra):
    rate_limit._hits.clear()
    body = {"display_name": "Тест", "email": email, "password": password}
    body.update(extra)
    return client.post("/auth/register", json=body)


def _find(email):
    db = SessionLocal()
    try:
        return db.query(User).filter(func.lower(User.email) == email.strip().lower()).first()
    finally:
        db.close()


def _mark_verified(email):
    db = SessionLocal()
    try:
        u = db.query(User).filter(func.lower(User.email) == email.strip().lower()).first()
        u.is_email_verified = True
        db.commit()
    finally:
        db.close()


def _login(email, password="testpass123"):
    rate_limit._hits.clear()
    return client.post("/auth/login", json={"email": email, "password": password})


def _account(email, password="testpass123", **extra):
    assert _register(email, password, **extra).status_code == 200
    _mark_verified(email)
    res = _login(email, password)
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


# --------------------------------------------------------------- имейл (1)

def test_the_same_mailbox_cannot_get_two_accounts():
    # Точният случай от продукцията: EmailStr смъква домейна, но не и името
    # преди кучето, и "Ivan@Abv.bg" минаваше за друг адрес.
    assert _register("Ivan@Abv.bg").status_code == 200
    assert _register("ivan@abv.bg").status_code == 400
    assert _register("  IVAN@ABV.BG  ").status_code == 400

    db = SessionLocal()
    try:
        assert db.query(User).filter(func.lower(User.email) == "ivan@abv.bg").count() == 1
    finally:
        db.close()


def test_email_is_stored_lowercase():
    _register("MiXeD@Example.COM")
    assert _find("mixed@example.com").email == "mixed@example.com"


def test_login_ignores_capitalisation():
    _account("Case@Example.com")
    for spelling in ("Case@Example.com", "case@example.com", "CASE@EXAMPLE.COM"):
        assert _login(spelling).status_code == 200, spelling


def test_a_legacy_mixed_case_row_is_still_found(codes):
    # Заварен ред от Render, записан преди нормализацията. Търсенето трябва да
    # го намира — иначе поправката щеше да заключи точно тези хора отвън.
    _register("legacy@example.com")
    with engine.begin() as conn:
        conn.execute(text("UPDATE users SET email = 'Legacy@Example.com' "
                          "WHERE lower(email) = 'legacy@example.com'"))
    _mark_verified("legacy@example.com")

    assert _login("legacy@example.com").status_code == 200
    codes.clear()
    res = client.post("/auth/forgot-password", json={"channel": "email", "contact": "LEGACY@EXAMPLE.COM"})
    assert res.status_code == 200
    assert len(codes) == 1, "заварен акаунт с главни букви трябва да получи код"


def test_bulgarian_phone_spellings_collapse_to_one_number():
    assert auth.normalize_phone("0888 123 456") == "+359888123456"
    assert auth.normalize_phone("+359 888 123 456") == "+359888123456"
    assert auth.normalize_phone("00359888123456") == "+359888123456"
    assert auth.normalize_phone("(0888) 123-456") == "+359888123456"
    # чужд номер остава както е дошъл — не се правим, че го разбираме
    assert auth.normalize_phone("+442071234567") == "+442071234567"
    assert auth.normalize_phone(None) is None


# --------------------------------------------------------- кодове (2)

def test_a_new_code_invalidates_the_previous_one(codes):
    _account("codes@example.com")
    codes.clear()
    for _ in range(3):
        rate_limit._hits.clear()
        client.post("/auth/forgot-password", json={"channel": "email", "contact": "codes@example.com"})
    assert len(codes) == 3

    user = _find("codes@example.com")
    db = SessionLocal()
    try:
        alive = db.query(VerificationCode).filter(
            VerificationCode.user_id == user.id,
            VerificationCode.purpose == CodePurpose.reset_password,
            VerificationCode.used.is_(False),
        ).count()
    finally:
        db.close()
    assert alive == 1, "само последният код бива да е валиден"

    # старият код вече не сменя парола
    rate_limit._hits.clear()
    old = client.post("/auth/reset-password", json={
        "channel": "email", "contact": "codes@example.com",
        "code": codes[0], "new_password": "stolenpass1",
    })
    assert old.status_code == 400
    # а последният — сменя
    rate_limit._hits.clear()
    fresh = client.post("/auth/reset-password", json={
        "channel": "email", "contact": "codes@example.com",
        "code": codes[-1], "new_password": "freshpass1",
    })
    assert fresh.status_code == 200, fresh.text


def test_wrong_codes_lock_the_account_after_a_handful_of_tries(codes):
    _account("bruteforce@example.com")
    codes.clear()
    client.post("/auth/forgot-password", json={"channel": "email", "contact": "bruteforce@example.com"})

    statuses = []
    for _ in range(auth.MAX_CODE_ATTEMPTS + 1):
        rate_limit._hits.clear()
        statuses.append(client.post("/auth/reset-password", json={
            "channel": "email", "contact": "bruteforce@example.com",
            "code": "000000", "new_password": "guessedpass1",
        }))

    assert [r.status_code for r in statuses[:auth.MAX_CODE_ATTEMPTS]] == [400] * auth.MAX_CODE_ATTEMPTS
    # Заключването НЕ се обявява навън: отвън изглежда като пореден грешен код.
    # Иначе шестият отговор ставаше справка дали адресът има профил — виж
    # test_the_lock_does_not_reveal_which_addresses_exist.
    blocked = statuses[-1]
    assert blocked.status_code == 400
    # съобщението пак насочва сгрешилото дете към изчакване, без да твърди нищо
    assert "изчакай" in blocked.json()["detail"]
    # дори ВЕРНИЯТ код не минава, докато трае изчакването
    rate_limit._hits.clear()
    right = client.post("/auth/reset-password", json={
        "channel": "email", "contact": "bruteforce@example.com",
        "code": codes[-1], "new_password": "realownerpw1",
    })
    assert right.status_code == 400


def test_two_mistyped_codes_do_not_lock_anyone_out(codes):
    # Детето, което бърка — а то бърка — трябва да успее от третия път.
    _account("typo@example.com")
    codes.clear()
    client.post("/auth/forgot-password", json={"channel": "email", "contact": "typo@example.com"})
    for _ in range(2):
        rate_limit._hits.clear()
        assert client.post("/auth/reset-password", json={
            "channel": "email", "contact": "typo@example.com",
            "code": "000000", "new_password": "somethingnew1",
        }).status_code == 400
    rate_limit._hits.clear()
    ok = client.post("/auth/reset-password", json={
        "channel": "email", "contact": "typo@example.com",
        "code": codes[-1], "new_password": "somethingnew1",
    })
    assert ok.status_code == 200, ok.text


def test_the_lock_expires_on_its_own(codes):
    _account("cooloff@example.com")
    codes.clear()
    client.post("/auth/forgot-password", json={"channel": "email", "contact": "cooloff@example.com"})
    for _ in range(auth.MAX_CODE_ATTEMPTS):
        rate_limit._hits.clear()
        client.post("/auth/reset-password", json={
            "channel": "email", "contact": "cooloff@example.com",
            "code": "000000", "new_password": "nopenope123",
        })

    user = _find("cooloff@example.com")
    db = SessionLocal()
    try:
        row = db.query(auth.CodeAttempt).filter(auth.CodeAttempt.user_id == user.id).first()
        assert row.locked_until is not None
        # пренавиваме изчакването назад, вместо да чакаме петнадесет минути
        row.locked_until = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.commit()
    finally:
        db.close()

    rate_limit._hits.clear()
    ok = client.post("/auth/reset-password", json={
        "channel": "email", "contact": "cooloff@example.com",
        "code": codes[-1], "new_password": "afterwaiting1",
    })
    assert ok.status_code == 200, ok.text


# ------------------------------------------------ изброяване на акаунти (3)

def test_resend_code_answers_the_same_for_known_and_unknown_addresses():
    _register("enum-known@example.com")
    rate_limit._hits.clear()
    known = client.post("/auth/resend-code", json={"email": "enum-known@example.com"})
    rate_limit._hits.clear()
    unknown = client.post("/auth/resend-code", json={"email": "enum-nobody@example.com"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()


def test_verify_email_answers_the_same_for_known_and_unknown_addresses():
    _register("enum2-known@example.com")
    rate_limit._hits.clear()
    known = client.post("/auth/verify-email", json={"email": "enum2-known@example.com", "code": "123456"})
    rate_limit._hits.clear()
    unknown = client.post("/auth/verify-email", json={"email": "enum2-nobody@example.com", "code": "123456"})
    assert known.status_code == unknown.status_code == 400
    assert known.json() == unknown.json()

    # и вече потвърденият акаунт не се отличава по отговора си
    _mark_verified("enum2-known@example.com")
    rate_limit._hits.clear()
    done = client.post("/auth/verify-email", json={"email": "enum2-known@example.com", "code": "123456"})
    assert (done.status_code, done.json()) == (400, unknown.json())


def test_login_takes_similar_time_for_registered_and_unregistered_addresses():
    # Преди поправката несъществуващият адрес се връщаше без нито едно bcrypt
    # сравнение: ~5 мс срещу ~250 мс. Никакъв текст не крие такава разлика.
    _account("timing@example.com")

    def median_ms(email):
        xs = []
        for _ in range(5):
            rate_limit._hits.clear()
            t = time.perf_counter()
            client.post("/auth/login", json={"email": email, "password": "wrong-password-here"})
            xs.append((time.perf_counter() - t) * 1000)
        xs.sort()
        return xs[len(xs) // 2]

    known = median_ms("timing@example.com")
    unknown = median_ms("timing-nobody@example.com")
    # прагът е широк нарочно — тестът пази реда на величината, не милисекунди
    assert 0.4 < unknown / known < 2.5, f"registered {known:.1f} ms vs unknown {unknown:.1f} ms"


# ------------------------------------------------------ телефон (4)

def test_an_unverified_phone_claim_does_not_block_the_real_owner():
    squatter = _account("squatter@example.com")
    rate_limit._hits.clear()
    assert client.post("/auth/phone", json={"phone": "+359888777001"}, headers=squatter).status_code == 200

    owner = _account("owner@example.com")
    rate_limit._hits.clear()
    res = client.post("/auth/phone", json={"phone": "0888777001"}, headers=owner)
    assert res.status_code == 200, res.text


def test_a_verified_phone_is_taken(codes):
    owner = _account("phone-owner@example.com")
    codes.clear()
    rate_limit._hits.clear()
    client.post("/auth/phone", json={"phone": "+359888777002"}, headers=owner)
    rate_limit._hits.clear()
    assert client.post("/auth/verify-phone", json={"code": codes[-1]}, headers=owner).status_code == 200

    other = _account("phone-other@example.com")
    rate_limit._hits.clear()
    res = client.post("/auth/phone", json={"phone": "0888777002"}, headers=other)
    assert res.status_code == 400


def test_reset_by_sms_requires_a_verified_phone(codes):
    holder = _account("sms-holder@example.com")
    rate_limit._hits.clear()
    client.post("/auth/phone", json={"phone": "+359888777003"}, headers=holder)
    # номерът стои в профила, но НЕ е потвърден

    codes.clear()
    rate_limit._hits.clear()
    assert client.post("/auth/forgot-password",
                       json={"channel": "sms", "contact": "+359888777003"}).status_code == 200
    assert codes == [], "непотвърден номер не бива да получава код за смяна на парола"

    # и самата смяна не бива да намира акаунта по непотвърден номер
    user = _find("sms-holder@example.com")
    db = SessionLocal()
    try:
        db.add(VerificationCode(user_id=user.id, purpose=CodePurpose.reset_password,
                                code_hash=security.hash_code("424242"),
                                expires_at=security.code_expiry()))
        db.commit()
    finally:
        db.close()
    rate_limit._hits.clear()
    res = client.post("/auth/reset-password", json={
        "channel": "sms", "contact": "+359888777003",
        "code": "424242", "new_password": "takenover12",
    })
    assert res.status_code == 400
    assert _login("sms-holder@example.com").status_code == 200, "паролата не бива да е сменена"


# ------------------------------------------------------ сесии (5)

def test_changing_the_password_ends_every_older_session(codes):
    headers = _account("session@example.com")
    assert client.get("/auth/me", headers=headers).status_code == 200

    codes.clear()
    rate_limit._hits.clear()
    client.post("/auth/forgot-password", json={"channel": "email", "contact": "session@example.com"})
    rate_limit._hits.clear()
    assert client.post("/auth/reset-password", json={
        "channel": "email", "contact": "session@example.com",
        "code": codes[-1], "new_password": "afterreset12",
    }).status_code == 200

    # старият токен е от преди смяната — вече не важи
    assert client.get("/auth/me", headers=headers).status_code == 401
    # а новият вход работи
    fresh = _login("session@example.com", "afterreset12")
    assert fresh.status_code == 200
    assert client.get("/auth/me",
                      headers={"Authorization": f"Bearer {fresh.json()['token']}"}).status_code == 200


def test_a_token_without_a_version_claim_is_rejected():
    # Токените отпреди промяната нямат "tv". Приемането им би означавало, че
    # смяната на паролата още цял месец не прекратява нищо.
    headers = _account("legacy-token@example.com")
    user = _find("legacy-token@example.com")
    legacy = jwt.encode(
        {"sub": user.id, "exp": datetime.now(timezone.utc) + timedelta(days=30)},
        security.JWT_SECRET, algorithm=security.JWT_ALGORITHM,
    )
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {legacy}"}).status_code == 401
    # а токенът от текущия вход си работи
    assert client.get("/auth/me", headers=headers).status_code == 200


def test_optional_authentication_also_honours_the_token_version():
    user = _find("legacy-token@example.com") or _find("session@example.com")
    stale = jwt.encode(
        {"sub": user.id, "tv": (user.token_version or 0) + 99,
         "exp": datetime.now(timezone.utc) + timedelta(days=30)},
        security.JWT_SECRET, algorithm=security.JWT_ALGORITHM,
    )
    assert auth.get_current_user_optional(f"Bearer {stale}", SessionLocal()) is None


# ------------------------------------------------ едновременна регистрация (6)

def test_a_simultaneous_duplicate_registration_gets_400_not_500(monkeypatch):
    _register("race@example.com")
    # Симулираме прозореца между "провери" и "запиши": проверката не вижда реда,
    # който другият процес вече е записал. Досега това излизаше като 500.
    monkeypatch.setattr(auth, "_email_matches", lambda value: text("1 = 0"))
    res = _register("race@example.com")
    assert res.status_code == 400, res.text
    assert "акаунт" in res.json()["detail"]


def test_the_lock_does_not_reveal_which_addresses_exist(codes):
    """Заключването се брои по акаунт, тоест го има само за адрес с профил.

    Ако то се обявяваше навън с друг код на състоянието, петте грешни опита
    ставаха точно справката, която затворихме другаде: пращаш кодове към чужд
    адрес и по шестия отговор разбираш дали детето има профил в Climby. Затова
    двата случая — има акаунт и няма — трябва да си останат неразличими докрай.
    """
    _account("exists@example.com")
    codes.clear()

    def hammer(address):
        out = []
        for _ in range(auth.MAX_CODE_ATTEMPTS + 2):
            rate_limit._hits.clear()
            r = client.post("/auth/reset-password", json={
                "channel": "email", "contact": address,
                "code": "000000", "new_password": "guessedpass1",
            })
            out.append((r.status_code, r.json().get("detail")))
        return out

    assert hammer("exists@example.com") == hammer("nobody-here@example.com")

    # същото и при потвърждаването на имейл
    # тук нарочно НЕ потвърждаваме акаунта — това е случаят, който verify-email
    # обслужва, а и единственият, в който заключване изобщо може да се натрупа
    rate_limit._hits.clear()
    assert _register("unverified@example.com").status_code == 200
    codes.clear()

    def hammer_verify(address):
        out = []
        for _ in range(auth.MAX_CODE_ATTEMPTS + 2):
            rate_limit._hits.clear()
            r = client.post("/auth/verify-email", json={"email": address, "code": "000000"})
            out.append((r.status_code, r.json().get("detail")))
        return out

    assert hammer_verify("unverified@example.com") == hammer_verify("nobody-here@example.com")


def _median_ms(call, n=5):
    xs = []
    for _ in range(n):
        rate_limit._hits.clear()
        t = time.perf_counter()
        call()
        xs.append((time.perf_counter() - t) * 1000)
    xs.sort()
    return xs[len(xs) // 2]


def test_reset_password_takes_similar_time_for_known_and_unknown_addresses(codes):
    """Същият пропуск като при входа, но една врата по-нататък.

    Кодовете на състоянието и текстовете бяха изравнени, а времето — не:
    несъществуващият адрес се връщаше, без изобщо да стигне до сравнение на код
    (~6 мс), докато съществуващият минаваше през bcrypt (~230 мс). Мълчаливият
    отговор пак казваше кое дете има профил, стига да го измериш.
    """
    _account("resettiming@example.com")
    codes.clear()
    rate_limit._hits.clear()
    client.post("/auth/forgot-password",
                json={"channel": "email", "contact": "resettiming@example.com"})

    def attempt(address):
        return lambda: client.post("/auth/reset-password", json={
            "channel": "email", "contact": address,
            "code": "000000", "new_password": "guessedpass1",
        })

    known = _median_ms(attempt("resettiming@example.com"))
    unknown = _median_ms(attempt("reset-nobody@example.com"))
    assert 0.4 < unknown / known < 2.5, f"known {known:.1f} ms vs unknown {unknown:.1f} ms"


def test_a_locked_account_takes_as_long_as_an_unknown_address():
    """Заключването беше изравнено по код и по текст, но не и по време.

    Заключеният акаунт излизаше веднага, без сравнение (~5 мс), а непознатият
    адрес плащаше пълно bcrypt (~230 мс) — тоест бързият отговор беше признакът,
    че този адрес съществува И вече е заключен. Разликата беше дори обърната
    спрямо първоначалната, но също толкова четима.
    """
    rate_limit._hits.clear()
    assert _register("lockedtiming@example.com").status_code == 200
    for _ in range(auth.MAX_CODE_ATTEMPTS + 1):
        rate_limit._hits.clear()
        client.post("/auth/verify-email",
                    json={"email": "lockedtiming@example.com", "code": "111111"})

    def attempt(address):
        return lambda: client.post("/auth/verify-email",
                                   json={"email": address, "code": "111111"})

    locked = _median_ms(attempt("lockedtiming@example.com"))
    unknown = _median_ms(attempt("locked-nobody@example.com"))
    assert 0.4 < unknown / locked < 2.5, f"locked {locked:.1f} ms vs unknown {unknown:.1f} ms"
