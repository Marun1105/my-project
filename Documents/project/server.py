# server.py — бекендът. Пази API ключа, говори с Anthropic, пази базата данни, отговаря на браузъра.
#
# Локално:   python -m uvicorn server:app --reload
# На Render:  Render използва Start Command-а автоматично (виж по-долу).
#
# Инсталиране локално:  pip install -r requirements.txt
from dotenv import load_dotenv
load_dotenv()  # трябва да е преди другите импорти, за да заредят env променливите навреме

import base64
import binascii
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from anthropic import Anthropic, APIError
from sqlalchemy.orm import Session
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

import auth
import classes
import family
import focus_sessions
import planner
import migrations
import rate_limit
import scans
import tasks
from db import Base, engine, get_db
from models import ScanHistory, User

app = FastAPI()
client = Anthropic()  # чете ANTHROPIC_API_KEY от средата

Base.metadata.create_all(bind=engine)
# create_all прави липсващите таблици, но не и липсващите колони в стари таблици.
_applied = migrations.run()
if _applied:
    print("migrations applied:", ", ".join(_applied))

app.include_router(auth.router)
app.include_router(tasks.router)
app.include_router(planner.router)
app.include_router(scans.router)
app.include_router(focus_sessions.router)
app.include_router(family.router)
app.include_router(classes.router)

# Външната граница на всичко, което сървърът изобщо си позволява да прочете в паметта.
# Pydantic проверява размерите ЧАК СЛЕД като FastAPI е задържал цялото тяло, а после
# всяко копие (моделът, списъкът с блокове към Anthropic) го умножава. Измерено: тяло
# от 40 MB вдига пика на паметта с около 200 MB — една такава заявка убива инстанс с
# 512 MB, много преди лимитът от 12 заявки на час да е казал каквото и да е.
# Стойността е с широк запас над най-голямото истинско сканиране (виж MAX_ASK_IMAGES_CHARS),
# защото важи за всички ендпойнти, не само за /ask.
MAX_BODY_BYTES = 8 * 1024 * 1024

BODY_TOO_LARGE_MESSAGE = "Заявката е твърде голяма."


class _BodyTooLarge(Exception):
    pass


class BodySizeLimitMiddleware:
    """Отказва прекалено голямо тяло по Content-Length, преди то да е прочетено.

    Написано е като чист ASGI слой нарочно: BaseHTTPMiddleware сам буферира тялото,
    а точно това искаме да избегнем. За заявки без Content-Length (chunked) броим
    байтовете, докато пристигат, и спираме по средата.
    """

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = Headers(scope=scope).get("content-length")
        if declared and declared.isdigit() and int(declared) > self.max_bytes:
            await self._reject(scope, receive, send)
            return

        seen = 0
        started = False

        async def counting_receive():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise _BodyTooLarge()
            return message

        async def watching_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, watching_send)
        except _BodyTooLarge:
            if started:
                raise  # отговорът вече е тръгнал — няма как да го заменим
            await self._reject(scope, receive, send)

    async def _reject(self, scope, receive, send):
        response = JSONResponse({"detail": BODY_TOO_LARGE_MESSAGE}, status_code=413)
        await response(scope, receive, send)


# Добавя се ПРЕДИ CORS: Starlette навива последно добавения най-отвън, така че CORS
# остава най-външен и слага заглавките си и върху отказа 413 — иначе браузърът вижда
# само "мрежова грешка" вместо ясното съобщение.
app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_BODY_BYTES)

# Браузърът/приложението и сървърът са на различни адреси, затова се иска
# разрешение да вика сървъра. Когато качиш страницата на твоя домейн,
# за по-сигурно замени "*" с адреса на сайта ти,
# напр. "https://martin.hristov.website".
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# "Всички предмети, с малки изключения" — учителят не се ограничава само до математика.
# Изключения като физическо възпитание или музикално изпълнение не стават чрез снимка на страница,
# затова моделът сам казва кога темата не е подходяща за този начин на учене, вместо да отгатва.
SYSTEM = {
    "bg": """Ти си учител, който помага на ученици от 1-ви до 12-ти клас с домашните им.
Пред теб има една или няколко снимки на страници от учебник (по всеки предмет — математика, български,
природни науки, история и т.н.), или снимки на решение, което ученикът е написал сам. Ако снимките са
повече от една, те обикновено са части от един и същ проблем (напр. продължение на текста на следваща
страница) — гледай ги заедно, освен ако не изглеждат явно несвързани.

Правила:
- Обяснявай на български, стъпка по стъпка, ясно и просто, на ниво, подходящо за ученика.
- Не давай само отговора — покажи как се стига до него, за да се научи ученикът.
- Ако ученикът е снимал свое решение, провери го и посочи точно къде е сгрешил — насърчаващо, не строго.
- Ако предметът не е подходящ за обяснение чрез снимка на страница (напр. физическо възпитание,
  практическо музикално изпълнение), кажи го учтиво, вместо да отгатваш отговор.
- Можеш да използваш Markdown и LaTeX между $...$ или $$...$$ — отговорът се показва в браузър.""",
    "en": """You are a teacher helping students from grade 1 to grade 12 with their homework.
You're shown one or more photos of textbook pages (any subject — math, language arts, science, history,
etc.), or photos of a solution the student wrote themselves. When there's more than one photo, they're
usually parts of the same problem (e.g. text continuing onto the next page) — read them together unless
they clearly look unrelated.

Rules:
- Explain in English, step by step, clearly and simply, at a level appropriate for the student.
- Don't just give the answer — show how to get there, so the student actually learns.
- If the student photographed their own solution, check it and point out exactly where they went
  wrong — encouragingly, not strictly.
- If the subject isn't suited to explanation via a page photo (e.g. physical education, a practical
  music performance), say so politely instead of guessing an answer.
- You can use Markdown and LaTeX between $...$ or $$...$$ — the answer is rendered in a browser.""",
}


# Колко голяма е ЕДНА истинска снимка. frontend/scanner.js свива всяка страница до
# 1568 пиксела по дългата страна и я кодира като JPEG с качество 0.82 — това дава
# около 150-400 KB, т.е. под 550 000 знака base64 дори за гъсто напечатана страница.
# 1 400 000 знака (≈1 MB JPEG) оставя двоен запас за друг клиент, който праща
# по-малко смалена снимка, но спира "снимка" от 50 MB.
MAX_ASK_IMAGE_CHARS = 1_400_000
# И осемте страници заедно: осем истински сканирания са около 3 MB base64.
# Таванът важи за сбора, защото иначе 8 x 1.4 MB пак прави 11 MB на заявка.
MAX_ASK_IMAGES_CHARS = 6_000_000

# По първите байтове познаваме формата — и заедно с това проверяваме, че низът
# изобщо е образ, а не 5 MB букви "A", които Anthropic ще откаже, но ние вече ще сме
# платили с памет за тях.
_IMAGE_SIGNATURES = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def _image_media_type(b64: str) -> Optional[str]:
    """Типът на образа по началото на base64 низа, или None ако не е разпознат образ."""
    try:
        head = base64.b64decode(b64[:16], validate=True)  # 16 знака -> 12 байта
    except (binascii.Error, ValueError):
        return None
    for signature, media_type in _IMAGE_SIGNATURES:
        if head.startswith(signature):
            return media_type
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


class Ask(BaseModel):
    # Без таван един клиент в рамките на лимита може да прати десетки снимки в
    # пълен размер наведнъж — сметката при Anthropic е за негова сметка, но се
    # плаща от този сървър. Осем страници стигат за най-дългото домашно.
    images: List[str] = Field(max_length=8)
    question: str = Field(max_length=2000)
    # Кратък езиков код; без таван и това поле е място, откъдето влиза мегабайт текст.
    lang: str = Field(default="bg", max_length=16)

    @field_validator("images")
    @classmethod
    def _check_images(cls, images: List[str]) -> List[str]:
        # Редът е нарочен: първо евтините проверки за дължина, чак после декодиране —
        # оразмерена атака не бива да ни кара да разпакетираме мегабайти, за да я откажем.
        total = 0
        for img in images:
            if len(img) > MAX_ASK_IMAGE_CHARS:
                raise ValueError("Снимката е твърде голяма — сканирай я пак от приложението.")
            total += len(img)
        if total > MAX_ASK_IMAGES_CHARS:
            raise ValueError("Снимките са твърде големи общо — прати ги на по-малко части.")

        for img in images:
            if _image_media_type(img) is None:
                raise ValueError("Една от снимките не е разпознаваем образ.")
            try:
                # Пълното декодиране е единственият честен начин да проверим, че и
                # останалата част е валиден base64; резултатът се изхвърля веднага.
                base64.b64decode(img, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("Една от снимките не е валиден base64.")
        return images


RATE_LIMIT_MESSAGE = {
    "bg": "Твърде много опити за кратко време — изчакай малко и опитай пак.",
    "en": "Too many requests in a short time — please wait a bit and try again.",
}

ASK_ERROR_MESSAGE = {
    "bg": "Нещо се обърка при разпознаването на снимката. Опитай с друга снимка или пак след малко.",
    "en": "Something went wrong reading the photo. Try a different photo or try again shortly.",
}


@app.get("/")
def health():
    # Проста проверка, че сървърът е жив — отваряш адреса и виждаш това.
    return {"status": "ok"}


@app.post("/ask")
def ask(
    body: Ask,
    request: Request,
    user: Optional[User] = Depends(auth.get_current_user_optional),
    db: Session = Depends(get_db),
):
    lang = body.lang if body.lang in SYSTEM else "bg"
    # /ask е достъпен и за гости (без вход), затова лимитът е по IP, а не по акаунт —
    # пази от неограничени разходи за Anthropic API от един клиент/бот.
    rate_limit.enforce(request, "ask", max_calls=12, window_seconds=3600, message=RATE_LIMIT_MESSAGE[lang])
    # Типът се взима от самата снимка, а не се предполага: приложението праща JPEG,
    # но качен от компютър файл спокойно може да е PNG и тогава "image/jpeg" е лъжа.
    content = [
        {"type": "image", "source": {
            "type": "base64", "media_type": _image_media_type(img) or "image/jpeg", "data": img}}
        for img in body.images
    ]
    content.append({"type": "text", "text": body.question})
    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1500,
            system=SYSTEM[lang],
            messages=[{"role": "user", "content": content}],
        )
    except APIError:
        raise HTTPException(502, ASK_ERROR_MESSAGE[lang])
    answer = "".join(b.text for b in resp.content if b.type == "text")

    if user:
        # Пазим само текста на въпроса/отговора за историята — снимките никога не се записват.
        db.add(ScanHistory(user_id=user.id, question=body.question, answer=answer, lang=lang))
        db.commit()

    return {"answer": answer}
