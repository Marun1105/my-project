# test_devices.py — снимка от телефона към компютъра: свързване, пращане, прибиране.
#
# Пускане:  python -m pytest test_devices.py -q
import base64
import os
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

# Временна база ОЩЕ преди внасянето на server.py — иначе тестовете биха писали
# в истинския climby.db.
_tmp_db = os.path.join(tempfile.mkdtemp(), "devices.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import devices  # noqa: E402
import rate_limit  # noqa: E402
import server  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import PairedDevice, PairRequest, PhonePhoto, User  # noqa: E402

client = TestClient(server.app)

# Най-малкият истински JPEG: два байта данни зад валиден заглавен блок. Важното е
# първите байтове да са ff d8 ff, защото точно по тях сървърът разпознава образа.
TINY_JPEG = base64.b64encode(
    bytes.fromhex("ffd8ffe000104a46494600010100000100010000") + b"\x00" * 32 + bytes.fromhex("ffd9")
).decode()


@pytest.fixture(autouse=True)
def _clean():
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()
    db = SessionLocal()
    db.query(PhonePhoto).delete()
    db.query(PairedDevice).delete()
    db.query(PairRequest).delete()
    db.commit()
    db.close()


_counter = {"n": 0}


def _login(display_name="Мартин"):
    _counter["n"] += 1
    email = f"dev{_counter['n']}@example.com"
    password = "testpass123"
    client.post("/auth/register", json={
        "display_name": display_name, "email": email, "password": password,
    })
    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    user.is_email_verified = True
    db.commit()
    db.close()
    res = client.post("/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def _secret_from(url):
    return url.rsplit("/p/", 1)[1]


def _pair(headers, user_agent=""):
    """Целият път компютър -> QR -> телефон, както го минава човек."""
    started = client.post("/devices/pair", headers=headers)
    assert started.status_code == 200, started.text
    secret = _secret_from(started.json()["url"])
    claimed = client.post(
        f"/devices/pair/{secret}/claim",
        json={"device_name": None},
        headers={"User-Agent": user_agent} if user_agent else {},
    )
    assert claimed.status_code == 200, claimed.text
    return started.json(), {"Authorization": f"Device {claimed.json()['token']}"}


# --------------------------------------------------------------------------
# основният път
# --------------------------------------------------------------------------

def test_a_photo_taken_on_the_phone_reaches_the_computer():
    headers = _login()
    _, phone = _pair(headers)

    assert client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone).status_code == 200

    collected = client.get("/devices/photos", headers=headers)
    assert collected.status_code == 200
    photos = collected.json()
    assert len(photos) == 1
    assert photos[0]["data"] == TINY_JPEG
    assert photos[0]["media_type"] == "image/jpeg"


def test_a_collected_photo_is_gone_from_the_database():
    headers = _login()
    _, phone = _pair(headers)
    client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)

    assert len(client.get("/devices/photos", headers=headers).json()) == 1
    # Второто прибиране е празно — и в базата наистина не е останало нищо.
    assert client.get("/devices/photos", headers=headers).json() == []
    db = SessionLocal()
    assert db.query(PhonePhoto).count() == 0
    db.close()


def test_photos_arrive_in_the_order_they_were_shot():
    headers = _login()
    _, phone = _pair(headers)
    second = base64.b64encode(base64.b64decode(TINY_JPEG) + b"\x00").decode()
    client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)
    client.post("/devices/photos", json={"image": second}, headers=phone)

    got = [p["data"] for p in client.get("/devices/photos", headers=headers).json()]
    assert got == [TINY_JPEG, second]


def test_one_persons_photo_never_lands_on_another_persons_computer():
    mine = _login("Мартин")
    theirs = _login("Друг")
    _, phone = _pair(mine)
    client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)

    assert client.get("/devices/photos", headers=theirs).json() == []
    assert len(client.get("/devices/photos", headers=mine).json()) == 1


# --------------------------------------------------------------------------
# поканата
# --------------------------------------------------------------------------

def test_the_same_code_shows_on_both_screens():
    headers = _login("Мартин")
    started = client.post("/devices/pair", headers=headers).json()
    info = client.get(f"/devices/pair/{_secret_from(started['url'])}/info").json()

    assert info["confirm_code"] == started["confirm_code"]
    assert info["display_name"] == "Мартин"


def test_a_pairing_code_works_only_once():
    headers = _login()
    started = client.post("/devices/pair", headers=headers).json()
    secret = _secret_from(started["url"])

    assert client.post(f"/devices/pair/{secret}/claim", json={}).status_code == 200
    again = client.post(f"/devices/pair/{secret}/claim", json={})
    assert again.status_code == 400
    assert "изтекъл" in again.json()["detail"]


def test_an_expired_pairing_code_is_refused():
    headers = _login()
    started = client.post("/devices/pair", headers=headers).json()
    secret = _secret_from(started["url"])

    db = SessionLocal()
    pair = db.query(PairRequest).first()
    pair.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    db.close()

    assert client.get(f"/devices/pair/{secret}/info").status_code == 400
    assert client.post(f"/devices/pair/{secret}/claim", json={}).status_code == 400


def test_an_unknown_and_an_expired_code_are_indistinguishable():
    headers = _login()
    started = client.post("/devices/pair", headers=headers).json()
    db = SessionLocal()
    db.query(PairRequest).first().expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    db.close()

    expired = client.get(f"/devices/pair/{_secret_from(started['url'])}/info")
    invented = client.get("/devices/pair/nothing-like-a-real-secret/info")
    assert expired.status_code == invented.status_code == 400
    assert expired.json() == invented.json()


def test_asking_for_a_new_code_kills_the_old_one():
    headers = _login()
    first = client.post("/devices/pair", headers=headers).json()
    client.post("/devices/pair", headers=headers)

    # Човекът гледа новия код на екрана; старият не бива да е още жив.
    assert client.get(f"/devices/pair/{_secret_from(first['url'])}/info").status_code == 400


def test_pairing_needs_a_logged_in_computer():
    assert client.post("/devices/pair").status_code == 401


def test_the_phone_gets_a_name_it_will_recognise():
    headers = _login()
    _pair(headers, user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")
    listed = client.get("/devices", headers=headers).json()
    assert listed[0]["name"] == "iPhone"


def test_a_typed_name_beats_the_guess():
    headers = _login()
    started = client.post("/devices/pair", headers=headers).json()
    client.post(
        f"/devices/pair/{_secret_from(started['url'])}/claim",
        json={"device_name": "Телефонът на Мартин"},
        headers={"User-Agent": "Mozilla/5.0 (iPhone)"},
    )
    assert client.get("/devices", headers=headers).json()[0]["name"] == "Телефонът на Мартин"


# --------------------------------------------------------------------------
# токенът на телефона отваря само две врати
# --------------------------------------------------------------------------

def test_the_phone_token_cannot_open_the_rest_of_the_account():
    headers = _login()
    _, phone = _pair(headers)

    # Схемата е "Device", не "Bearer" — тя не минава изобщо през входа за акаунта.
    for path in ("/auth/me", "/tasks", "/scans", "/classes", "/devices"):
        assert client.get(path, headers=phone).status_code == 401, path

    # И обратното: същият низ, представен като вход в акаунт, също не важи.
    raw = phone["Authorization"].split(" ", 1)[1]
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {raw}"}).status_code == 401


def test_the_phone_token_cannot_collect_photos():
    """Прибирането е за компютъра. Телефон, който може и да чете, вече не е ограничен."""
    headers = _login()
    _, phone = _pair(headers)
    client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)

    assert client.get("/devices/photos", headers=phone).status_code == 401


def test_an_invented_phone_token_is_refused():
    assert client.post(
        "/devices/photos",
        json={"image": TINY_JPEG},
        headers={"Authorization": "Device not-a-real-token"},
    ).status_code == 401


def test_a_forgotten_phone_stops_working_immediately():
    headers = _login()
    _, phone = _pair(headers)
    device_id = client.get("/devices", headers=headers).json()[0]["id"]

    assert client.delete(f"/devices/{device_id}", headers=headers).status_code == 200
    assert client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone).status_code == 401
    assert client.get("/devices/me", headers=phone).status_code == 401


def test_forgetting_a_phone_takes_its_uncollected_photos_with_it():
    headers = _login()
    _, phone = _pair(headers)
    client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)
    device_id = client.get("/devices", headers=headers).json()[0]["id"]

    client.delete(f"/devices/{device_id}", headers=headers)
    assert client.get("/devices/photos", headers=headers).json() == []


def test_nobody_can_forget_somebody_elses_phone():
    mine = _login()
    theirs = _login()
    _pair(mine)
    device_id = client.get("/devices", headers=mine).json()[0]["id"]

    assert client.delete(f"/devices/{device_id}", headers=theirs).status_code == 404
    assert len(client.get("/devices", headers=mine).json()) == 1


# --------------------------------------------------------------------------
# тавани
# --------------------------------------------------------------------------

def test_a_fourth_phone_is_refused_with_an_explanation():
    headers = _login()
    for _ in range(devices.MAX_DEVICES_PER_USER):
        _pair(headers)

    started = client.post("/devices/pair", headers=headers).json()
    res = client.post(f"/devices/pair/{_secret_from(started['url'])}/claim", json={})
    assert res.status_code == 400
    assert "Откачи" in res.json()["detail"]
    assert len(client.get("/devices", headers=headers).json()) == devices.MAX_DEVICES_PER_USER


def test_a_refused_fourth_phone_still_burns_its_code():
    """Иначе същият QR код би стоял жив на екрана след неуспешен опит."""
    headers = _login()
    for _ in range(devices.MAX_DEVICES_PER_USER):
        _pair(headers)
    started = client.post("/devices/pair", headers=headers).json()
    secret = _secret_from(started["url"])
    client.post(f"/devices/pair/{secret}/claim", json={})

    assert client.get(f"/devices/pair/{secret}/info").status_code == 400


def test_the_oldest_waiting_photo_falls_out_rather_than_the_newest():
    headers = _login()
    _, phone = _pair(headers)
    for i in range(devices.MAX_UNDELIVERED_PHOTOS + 1):
        image = base64.b64encode(base64.b64decode(TINY_JPEG) + bytes([i])).decode()
        assert client.post("/devices/photos", json={"image": image}, headers=phone).status_code == 200

    photos = client.get("/devices/photos", headers=headers).json()
    assert len(photos) == devices.MAX_UNDELIVERED_PHOTOS
    # Последната направена снимка е тази, която човекът чака — тя трябва да е тук.
    newest = base64.b64encode(
        base64.b64decode(TINY_JPEG) + bytes([devices.MAX_UNDELIVERED_PHOTOS])
    ).decode()
    assert photos[-1]["data"] == newest


def test_a_phone_left_shooting_in_a_pocket_hits_an_hourly_ceiling():
    headers = _login()
    _, phone = _pair(headers)
    for _ in range(devices.MAX_PHOTOS_PER_HOUR):
        assert client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone).status_code == 200

    res = client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)
    assert res.status_code == 429


def test_the_hourly_ceiling_lifts_when_the_hour_passes():
    headers = _login()
    _, phone = _pair(headers)
    for _ in range(devices.MAX_PHOTOS_PER_HOUR):
        client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)
    assert client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone).status_code == 429

    db = SessionLocal()
    device = db.query(PairedDevice).first()
    device.photos_hour_start = datetime.now(timezone.utc) - timedelta(hours=1, minutes=1)
    db.commit()
    db.close()

    assert client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone).status_code == 200


def test_something_that_is_not_an_image_is_refused():
    headers = _login()
    _, phone = _pair(headers)
    junk = base64.b64encode(b"A" * 400).decode()
    assert client.post("/devices/photos", json={"image": junk}, headers=phone).status_code == 422


def test_a_photo_that_is_too_big_is_refused_before_it_is_decoded():
    headers = _login()
    _, phone = _pair(headers)
    huge = "A" * (2_000_000)
    assert client.post("/devices/photos", json={"image": huge}, headers=phone).status_code == 422


# --------------------------------------------------------------------------
# метене
# --------------------------------------------------------------------------

def test_a_photo_nobody_collected_does_not_live_forever():
    headers = _login()
    _, phone = _pair(headers)
    client.post("/devices/photos", json={"image": TINY_JPEG}, headers=phone)

    db = SessionLocal()
    photo = db.query(PhonePhoto).first()
    photo.created_at = datetime.now(timezone.utc) - timedelta(
        minutes=devices.PHOTO_TTL_MINUTES + 1
    )
    db.commit()
    db.close()

    assert client.get("/devices/photos", headers=headers).json() == []


def test_an_expired_pairing_row_is_swept_away():
    headers = _login()
    client.post("/devices/pair", headers=headers)
    db = SessionLocal()
    db.query(PairRequest).first().expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    db.close()

    client.post("/devices/pair", headers=headers)  # всяко минаване оттук мете

    db = SessionLocal()
    assert db.query(PairRequest).count() == 1  # само новата
    db.close()


# --------------------------------------------------------------------------
# страницата, която телефонът отваря
# --------------------------------------------------------------------------

def test_the_phone_page_is_served_and_carries_no_secret_in_its_html():
    headers = _login()
    started = client.post("/devices/pair", headers=headers).json()
    secret = _secret_from(started["url"])

    res = client.get(f"/p/{secret}")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    # Страницата си чете тайната от адреса. Влезе ли тя в разметката, веднага се
    # появява въпросът "правилно ли е екранирана" — по-добре изобщо да я няма.
    assert secret not in res.text
    assert started["confirm_code"] not in res.text


def test_the_phone_page_does_not_leak_the_secret_through_referer():
    res = client.get("/p/anything")
    assert res.headers["referrer-policy"] == "no-referrer"


def test_the_phone_page_pulls_nothing_from_the_outside():
    res = client.get("/p/anything")
    csp = res.headers["content-security-policy"]
    assert "default-src 'none'" in csp
    assert "connect-src 'self'" in csp
    # Един файл, нула външни заявки — иначе заспалият Render става втора точка на отказ.
    assert "http://" not in res.text and "https://" not in res.text
