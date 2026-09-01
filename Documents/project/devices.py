# devices.py — снимка от телефона към компютъра.
#
# Защо изобщо съществува: настолният компютър почти никога няма камера, годна за
# страница от учебник, и точно това правеше раздела "Учител" безполезен на лаптоп
# (виж коментара за липсваща камера в frontend/scanner.js). Телефонът в джоба е
# по-добър скенер от всяка уеб камера — остава само снимката да стигне до екрана,
# на който детето пише.
#
# Пътят е кратък: компютърът показва QR код, телефонът го отваря, потвърждава се
# веднъж и оттам нататък телефонът остава свързан. Снимката минава през този
# сървър, защото това е единственото място, което и двете устройства виждат
# сигурно — домашният Wi-Fi не става (различни мрежи, защитни стени, а и камерата
# в браузър по обикновен HTTP изобщо не тръгва).
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

import rate_limit
from auth import get_current_user
from db import get_db
from models import PairedDevice, PairRequest, PhonePhoto, User
from schemas import (
    PairClaimOut,
    PairClaimRequest,
    PairedDeviceOut,
    PairInfoOut,
    PairStartOut,
    PhonePhotoOut,
    PhotoUploadRequest,
    image_media_type,
)

router = APIRouter(prefix="/devices", tags=["devices"])

# Поканата важи, колкото трае едно посягане към телефона. По-дълго не помага на
# никого, а оставя жив ключ на екрана, след като човекът е станал от бюрото.
PAIR_TTL_MINUTES = 10
# Несъбраната снимка се помита след същото време. Обикновено живее секунда-две —
# компютърът пита на всеки две секунди, докато разделът е отворен.
PHOTO_TTL_MINUTES = 10

# Телефон и таблет стигат на всекиго; третото място е за смяна на телефона, без
# да се налага първо да откачаш стария.
MAX_DEVICES_PER_USER = 3
# Толкова снимки могат да чакат несъбрани. Домашното е осем страници най-много
# (server.Ask ограничава /ask до 8), така че двайсет е широк запас — и същевременно
# таван, който пази базата от телефон, забравен да снима в джоба.
MAX_UNDELIVERED_PHOTOS = 20
# Около 400 KB на снимка: шейсет на час е повече, отколкото човек снима, и по-малко,
# отколкото безплатният Postgres би усетил.
MAX_PHOTOS_PER_HOUR = 60

# без 0/O/1/I — кодът се сравнява с очи между два екрана
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 5

BAD_PAIR_CODE = "Кодът за свързване е изтекъл или вече е използван. Покажи нов на компютъра."
NOT_PAIRED = "Телефонът вече не е свързан. Свържи го отново от компютъра."


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    # SQLite връща naive стойности, макар да са записани в UTC
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _fingerprint(value: str) -> str:
    """sha256 в шестнайсетичен вид — по него се търси редът.

    Нарочно НЕ е bcrypt, за разлика от паролите и кодовете за потвърждение.
    bcrypt слага случайна сол, затова по него не може да се търси, а бавността му
    пази СЛАБИ тайни, измислени от човек. Тук тайната е 32 случайни байта: за нея
    бавното хеширане не добавя нищо, а прякото търсене е задължително.
    """
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _confirm_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def _sweep(db: Session) -> None:
    """Изхвърля изтеклите покани и несъбраните снимки.

    Върши се при преминаване, а не с отделна задача по часовник: Render заспива
    безплатните услуги, така че задача по часовник просто не се случва. Всяко
    докосване до тези таблици и без това минава оттук.
    """
    now = _now()
    db.query(PairRequest).filter(PairRequest.expires_at < now).delete(synchronize_session=False)
    db.query(PhonePhoto).filter(
        PhonePhoto.created_at < now - timedelta(minutes=PHOTO_TTL_MINUTES)
    ).delete(synchronize_session=False)


def _device_name_from_agent(user_agent: str) -> str:
    """Име по подразбиране, което човекът да разпознае в списъка си."""
    ua = (user_agent or "").lower()
    if "ipad" in ua:
        return "iPad"
    if "iphone" in ua:
        return "iPhone"
    if "android" in ua:
        return "Телефон с Android"
    return "Телефон"


def get_device(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> PairedDevice:
    """Входът за телефона — нарочно НЕ е входът за акаунта.

    Схемата е "Device", а не "Bearer", и се проверява само тук. Токенът на
    телефона не минава през security.decode_token_claims и затова не отваря нито
    един от останалите ендпойнти: телефон, забравен отключен на чина, може да
    прати снимка и нищо друго.
    """
    prefix = "Device "
    if not authorization.startswith(prefix):
        raise HTTPException(401, "Телефонът не е свързан.")
    device = (
        db.query(PairedDevice)
        .filter(PairedDevice.token_hash == _fingerprint(authorization[len(prefix):]))
        .first()
    )
    if not device:
        # Същият отговор и когато телефонът е бил откачен от компютъра: за човека
        # това е едно и също положение и едно и също действие — свържи пак.
        raise HTTPException(401, NOT_PAIRED)
    return device


@router.post("/pair", response_model=PairStartOut)
def start_pairing(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Компютърът иска нов QR код."""
    rate_limit.enforce(request, "device-pair", max_calls=10, window_seconds=3600,
                       message="Твърде много опити за свързване — изчакай малко и опитай пак.")
    _sweep(db)

    # Стара покана от същия акаунт вече не трябва на никого: човекът гледа новия
    # код, а старият само би стоял жив без нужда.
    db.query(PairRequest).filter(PairRequest.user_id == user.id).delete(synchronize_session=False)

    secret = secrets.token_urlsafe(32)
    code = _confirm_code()
    expires_at = _now() + timedelta(minutes=PAIR_TTL_MINUTES)
    db.add(PairRequest(
        user_id=user.id,
        secret_hash=_fingerprint(secret),
        confirm_code=code,
        expires_at=expires_at,
    ))
    db.commit()

    # Адресът се сглобява от заглавките на самата заявка, а не от записана
    # настройка: сървърът върви и локално, и на Render, а QR кодът е безполезен,
    # ако сочи към другия.
    base = str(request.base_url).rstrip("/")
    return PairStartOut(url=f"{base}/p/{secret}", confirm_code=code, expires_at=expires_at)


def _live_request(db: Session, secret: str) -> PairRequest:
    _sweep(db)
    pair = (
        db.query(PairRequest)
        .filter(PairRequest.secret_hash == _fingerprint(secret))
        .first()
    )
    # Изтекла и несъществуваща покана дават един и същ отговор и по едно и също
    # време: и двата пътя са едно търсене по индекс, без бавно хеширане, което
    # другаде разделя "има такъв" от "няма".
    if not pair or _aware(pair.expires_at) < _now():
        raise HTTPException(400, BAD_PAIR_CODE)
    return pair


@router.get("/pair/{secret}/info", response_model=PairInfoOut)
def pairing_info(secret: str, db: Session = Depends(get_db)):
    """Телефонът пита към кой профил го канят, преди човекът да потвърди."""
    pair = _live_request(db, secret)
    owner = db.get(User, pair.user_id)
    if not owner:
        raise HTTPException(400, BAD_PAIR_CODE)
    return PairInfoOut(display_name=owner.display_name, confirm_code=pair.confirm_code)


@router.post("/pair/{secret}/claim", response_model=PairClaimOut)
def claim_pairing(
    secret: str,
    body: PairClaimRequest,
    request: Request,
    user_agent: str = Header(default=""),
    db: Session = Depends(get_db),
):
    """Човекът е потвърдил на телефона — тук поканата става връзка."""
    rate_limit.enforce(request, "device-claim", max_calls=20, window_seconds=3600,
                       message="Твърде много опити — изчакай малко и опитай пак.")
    pair = _live_request(db, secret)
    owner = db.get(User, pair.user_id)
    if not owner:
        raise HTTPException(400, BAD_PAIR_CODE)

    # Поканата е за един телефон и си отива веднага — включително ако проверката
    # за брой устройства по-долу откаже. Иначе същият QR код би стоял жив на
    # екрана и след неуспешен опит.
    db.delete(pair)
    db.flush()

    paired = db.query(PairedDevice).filter(PairedDevice.user_id == owner.id).count()
    if paired >= MAX_DEVICES_PER_USER:
        db.commit()
        raise HTTPException(
            400,
            f"Вече имаш {MAX_DEVICES_PER_USER} свързани устройства. "
            "Откачи едно от настройките на компютъра и опитай пак.",
        )

    name = (body.device_name or "").strip() or _device_name_from_agent(user_agent)
    token = secrets.token_urlsafe(32)
    db.add(PairedDevice(
        user_id=owner.id,
        name=name,
        token_hash=_fingerprint(token),
        last_seen_at=_now(),
    ))
    db.commit()
    return PairClaimOut(token=token, user_display_name=owner.display_name, device_name=name)


@router.get("/me")
def device_me(device: PairedDevice = Depends(get_device), db: Session = Depends(get_db)):
    """Телефонът проверява при отваряне дали още е свързан."""
    owner = db.get(User, device.user_id)
    if not owner:
        raise HTTPException(401, NOT_PAIRED)
    return {"status": "ok", "user_display_name": owner.display_name, "device_name": device.name}


@router.post("/photos")
def upload_photo(
    body: PhotoUploadRequest,
    device: PairedDevice = Depends(get_device),
    db: Session = Depends(get_db),
):
    """Телефонът праща снимка. Тя чака компютъра — секунди, не повече."""
    _sweep(db)

    now = _now()
    started = _aware(device.photos_hour_start)
    if started is None or started < now - timedelta(hours=1):
        device.photos_hour_start = now
        device.photos_this_hour = 0
    if device.photos_this_hour >= MAX_PHOTOS_PER_HOUR:
        db.commit()  # запазваме преместения прозорец, дори когато отказваме
        raise HTTPException(429, "Твърде много снимки за кратко време — изчакай малко.")

    waiting = db.query(PhonePhoto).filter(PhonePhoto.user_id == device.user_id).count()
    if waiting >= MAX_UNDELIVERED_PHOTOS:
        # Най-старата пада, вместо новата да бъде отказана: човекът гледа снимката,
        # която току-що е направил, а не онази отпреди девет минути.
        oldest = (
            db.query(PhonePhoto)
            .filter(PhonePhoto.user_id == device.user_id)
            .order_by(PhonePhoto.created_at.asc())
            .first()
        )
        if oldest:
            db.delete(oldest)

    device.photos_this_hour += 1
    device.last_seen_at = now
    db.add(PhonePhoto(
        user_id=device.user_id,
        device_id=device.id,
        data=body.image,
        media_type=image_media_type(body.image) or "image/jpeg",
    ))
    db.commit()
    return {"status": "ok"}


@router.get("/photos", response_model=List[PhonePhotoOut])
def collect_photos(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Компютърът прибира каквото е пристигнало — и с това го изтрива.

    Взимането е и изтриване нарочно: снимката вече е в ръцете на компютъра, а
    всяка секунда след това тя стои в базата без причина. Затова и обновяването
    на страницата по средата губи една снимка — цената е приемлива пред това
    снимки да се трупат.
    """
    _sweep(db)
    photos = (
        db.query(PhonePhoto)
        .filter(PhonePhoto.user_id == user.id)
        .order_by(PhonePhoto.created_at.asc())
        .all()
    )
    out = [
        PhonePhotoOut(id=p.id, data=p.data, media_type=p.media_type, created_at=p.created_at)
        for p in photos
    ]
    for photo in photos:
        db.delete(photo)
    db.commit()
    return out


@router.get("", response_model=List[PairedDeviceOut])
def list_devices(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.query(PairedDevice)
        .filter(PairedDevice.user_id == user.id)
        .order_by(PairedDevice.created_at.asc())
        .all()
    )


@router.delete("/{device_id}")
def forget_device(device_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Откачане на телефон — токенът му спира да важи веднага.

    Заедно с него си отиват и снимките, които е пратил и никой не е прибрал:
    човекът, който откача изгубен телефон, не иска да остави нищо след него.
    """
    device = (
        db.query(PairedDevice)
        .filter(PairedDevice.id == device_id, PairedDevice.user_id == user.id)
        .first()
    )
    if not device:
        raise HTTPException(404, "Такова устройство не е свързано.")
    db.query(PhonePhoto).filter(PhonePhoto.device_id == device.id).delete(synchronize_session=False)
    db.delete(device)
    db.commit()
    return {"status": "ok"}
