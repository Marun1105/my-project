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
from pathlib import Path
from typing import List, Optional, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from anthropic import Anthropic, APIError
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.datastructures import Headers
from starlette.responses import HTMLResponse, JSONResponse, Response

import auth
import classes
import devices
import family
import focus_sessions
import planner
import migrations
import email_service
import oauth
import papers
import account
import activity
import rate_limit
import scans
import tasks
import usage
from db import Base, SessionLocal, engine, get_db
from models import ScanHistory, Task, User
from schemas import image_media_type

app = FastAPI()
client = Anthropic()  # чете ANTHROPIC_API_KEY от средата

# Схемата се пипа от всеки работник при вдигане, а на Render работниците са
# няколко и тръгват едновременно. Затова цялата стъпка минава под една ключалка:
# без нея двамата виждаха една и съща липсваща колона, и двамата пускаха ALTER, и
# загубилият падаше с DuplicateColumn още при внасянето на този модул — тоест
# сървърът се вдигаше наполовина или се рестартираше в кръг.
with migrations.schema_lock():
    # create_all прави липсващите таблици, но не и липсващите колони в стари таблици.
    migrations.create_schema(Base.metadata)
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
app.include_router(devices.router)
app.include_router(activity.router)
app.include_router(account.router)
app.include_router(oauth.router)
app.include_router(papers.router)

# Външната граница на всичко, което сървърът изобщо си позволява да прочете в паметта.
# Pydantic проверява размерите ЧАК СЛЕД като FastAPI е задържал цялото тяло, а после
# всяко копие (моделът, списъкът с блокове към Anthropic) го умножава. Измерено: тяло
# от 40 MB вдига пика на паметта с около 200 MB — една такава заявка убива инстанс с
# 512 MB, много преди лимитът от 12 заявки на час да е казал каквото и да е.
# Стойността е с широк запас над най-голямото истинско сканиране (виж MAX_ASK_IMAGES_CHARS),
# защото важи за всички ендпойнти, не само за /ask.
MAX_BODY_BYTES = 8 * 1024 * 1024

BODY_TOO_LARGE_MESSAGE = "That request is too large."


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
    # The export names its file in this header; without exposing it the app
    # cannot read it across origins and falls back to a generic name.
    expose_headers=["Content-Disposition"],
)

# "Всички предмети, с малки изключения" — учителят не се ограничава само до математика.
# Изключения като физическо възпитание или музикално изпълнение не стават чрез снимка на страница,
# затова моделът сам казва кога темата не е подходяща за този начин на учене, вместо да отгатва.
# Appended to the prompt when the student has chosen full solutions in Settings.
# It overrides the ladder of hints, not the teaching: every step still says why.
FULL_SOLUTIONS = {
    "bg": "\n\nУченикът е избрал режим „Цяло решение“: дай пълното решение стъпка по стъпка, "
          "с обяснение защо се прави всяка стъпка. Не задържай отговора, но не пропускай и разсъждението.",
    "en": "\n\nThe student has chosen \"Full solutions\": give the complete solution step by step, "
          "explaining why each step is taken. Do not withhold the answer, and do not skip the reasoning.",
}

SYSTEM = {
    "bg": """Ти си ClimbAI — учителят вътре в приложението Climby. Помагаш на ученици от 1-ви до
12-ти клас с домашните им.

Това е разговор, не еднократен отговор: ученикът може да ти отговори и ти да продължиш.

Как учиш (по изследванията върху добрите учители — виж docs/ai-v-ucheneto.md):
- Учи, не казвай. Пълното решение се задържа по подразбиране. Стълба от подсказки: (1) насочи
  към идеята, която е нужна; (2) задай един насочващ въпрос; (3) покажи първата стъпка; (4) цялото
  решение — само ако ученикът изрично го поиска, или след два неуспешни опита. Ученик, който
  получава готови отговори, се справя по-добре сега и по-зле на контролното после.
- Един въпрос наведнъж, после чакай. Не задавай три въпроса в един отговор.
- Първият ти отговор трябва да е полезен и без продължение: обясни идеята и първата стъпка, после
  спри с насочващ въпрос или с „опитай следващата стъпка".
- Когато проверяваш решение на ученика: намери къде се е счупило МИСЛЕНЕТО, не само кой знак е
  сгрешен. Кажи първо какво е вярно, после точно едно нещо за поправяне.
- Съобразявай подкрепата с нивото: на по-малък ученик или при първи опит — разработен пример,
  стъпка по стъпка; на по-силен — по-малко, за да мисли сам. Твърде много помощ вреди на силния,
  твърде малко — на слабия.
- Карай ученика да обясни: „защо направи това?", „какво значи този резултат?". Обяснението назад
  закрепва повече от четенето напред.
- Кратко. Всеки отговор има естествен край и една следваща стъпка. Език за възрастта на ученика.
- Насърчаващо, без лекции и без похвали на празно. Никога не правиш домашното вместо него: ако
  поиска направо отговора, дай пътя и остави последната стъпка на него.

Форма:
- Обяснявай на български, ясно и просто, на ниво, подходящо за ученика.
- Ако предметът не може да се обясни оттук (напр. физическо възпитание, практическо музикално
  изпълнение), кажи го учтиво, вместо да отгатваш отговор.
- Можеш да използваш Markdown и LaTeX между $...$ или $$...$$ — отговорът се показва в браузър.""",
    "en": """You are ClimbAI — the tutor inside the Climby app. You help students from grade 1 to
grade 12 with their homework.

This is a conversation, not a one-shot answer: the student can reply and you continue.

How you teach (from the research on good tutors — see docs/ai-v-ucheneto.md):
- Teach, don't tell. The full solution is withheld by default. A ladder of hints: (1) point at the
  idea that is needed; (2) ask one guiding question; (3) show the first step; (4) the whole
  solution — only if the student explicitly asks, or after two failed attempts. Students handed
  answers do better now and worse on the test later.
- One question at a time, then wait. Never three questions in one reply.
- Your first reply must be useful even with no follow-up: explain the idea and the first step,
  then stop with a guiding question or "try the next step".
- When checking the student's work: find where the THINKING broke, not just which sign is wrong.
  Say what is right first, then exactly one thing to fix.
- Match support to the level: a younger student or a first attempt gets a worked example, step by
  step; a stronger one gets less, so they think. Too much help hurts the strong, too little hurts
  the weak.
- Make the student explain: "why did you do that?", "what does this result mean?". Explaining
  back sticks better than reading forward.
- Short. Every reply has a natural end and one next step. Language for the student's age.
- Encouraging, without lectures and without empty praise. Never do the homework for them: if they
  ask for the answer outright, give the path and leave the last step to them.

Form:
- Explain in English, clearly and simply, at a level appropriate for the student.
- If the subject can't be taught from here (e.g. physical education, a practical music
  performance), say so politely instead of guessing an answer.
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

# Разпознаването на формата по първите байтове живее в schemas.py: същата
# проверка трябва да важи и за снимката, която идва от телефона през
# /devices/photos. Едно копие на таблицата с подписи, а не две, които се
# разминават тихо.
_image_media_type = image_media_type


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=4000)


class Ask(BaseModel):
    # Без таван един клиент в рамките на лимита може да прати десетки снимки в
    # пълен размер наведнъж — сметката при Anthropic е за негова сметка, но се
    # плаща от този сървър. Осем страници стигат за най-дългото домашно.
    images: List[str] = Field(max_length=8)
    question: str = Field(min_length=1, max_length=2000)
    # Кратък езиков код; без таван и това поле е място, откъдето влиза мегабайт текст.
    lang: str = Field(default="en", max_length=16)
    # Предишните реплики на същия разговор, по ред, като текст. Снимките са в
    # images и се закачат към ПЪРВАТА реплика на ученика — те са контекстът на
    # целия разговор, а не на всеки въпрос поотделно. Таванът пази сметката:
    # всяка реплика отива при Anthropic отново с цялата история.
    history: List[Turn] = Field(default_factory=list, max_length=12)
    # How much the tutor holds back. "hints" is the research default — the
    # ladder of hints, solution last. "full" is a choice a student or parent can
    # make in Settings: complete worked solutions, still explained. Both are
    # teaching; one of them is what you want the night before a test.
    mode: Literal["hints", "full"] = "hints"
    # The chat sets this. With it, and a signed-in account, the tutor is told
    # what is on the student's Route and what they asked recently — so "what
    # should I start with?" and "like the one I asked yesterday" mean something.
    # Guests have nothing to show; the photo tutor doesn't ask for it.
    context: bool = False
    # Which screen asked. `context` above says "signed in, with extras", which is
    # a different question — and answering it with the same flag left the chat
    # offering to look at photographs it has no way of receiving.
    surface: Literal["chat", "tutor"] = "tutor"

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


# Единствената страница, която този сървър изобщо сервира. Приложението не се
# хоства никъде — стига до хората само през инсталатора — но телефонът няма
# откъде другаде да я вземе, а точно телефонът е камерата, която лаптопът няма.
# Чете се веднъж при вдигане: файлът не се променя, докато процесът върви, а
# четене от диска на всяка заявка би било чиста загуба.
_PHONE_PAGE = (Path(__file__).parent / "phone_page.html").read_text(encoding="utf-8")

# Страницата е един файл със свои стилове и свой скрипт вътре, и нищо не тегли
# отвън — затова 'unsafe-inline' тук не отпуска нищо: няма чужд произход, от
# който да дойде код. Всичко останало е забранено.
_PHONE_PAGE_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        "connect-src 'self'; img-src data: blob:; base-uri 'none'; form-action 'none'"
    ),
    # Тайната за свързване стои в адреса. Без това тя би тръгнала в заглавката
    # Referer към всеки адрес, който страницата някога докосне.
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
}


@app.get("/p/{secret}", response_class=HTMLResponse)
def phone_page(secret: str):
    # Тайната нарочно НЕ се вгражда в HTML-а — страницата си я чете сама от
    # адреса. Така никакъв текст от заявката не влиза в разметката и въпросът
    # "правилно ли е екранирано" изобщо не се появява.
    return HTMLResponse(_PHONE_PAGE, headers=_PHONE_PAGE_HEADERS)


@app.get("/phone", response_class=HTMLResponse)
def phone_page_paired():
    """Постоянният адрес на телефона — същата страница, само без покана в пътя.

    Свързаният телефон нямаше къде да се върне. Единственият адрес, който
    някога е имал, е /p/<тайна>, а тайната се изразходва при свързването:
    затвори ли се разделът, пътят назад минаваше през "забрави телефона" на
    компютъра и нов QR код — за затворен раздел.

    Тук няма какво да се проверява и затова няма и вход: токенът на устройството
    живее в localStorage на този произход и страницата сама пита с него
    /devices/me. Без токен посетителят вижда "липсва код" — същото, което вижда
    и с изтекла покана.
    """
    return HTMLResponse(_PHONE_PAGE, headers=_PHONE_PAGE_HEADERS)


# Всеки браузър иска /favicon.ico сам, без страницата да го е молила. Без този
# отговор всяко отваряне на сървъра в браузър оставя 404 в конзолата — грешка,
# която не значи нищо, но изглежда точно като грешка, която значи. Един и същи
# връх, вписан и в phone_page.html.
_FAVICON = (
    b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>"
    b"<rect width='32' height='32' rx='7' fill='#7c3aed'/>"
    b"<path d='M6 24 L13 11 L18 19 L21 15 L26 24 Z' fill='#fff'/>"
    b"</svg>"
)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(
        _FAVICON,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=604800"},
    )


# "/" казва само че процесът е жив. Точно това не стигаше: на 3 септември базата
# изтече, приложението падаше при вдигане и никой не разбра четири дни. Тук се
# пипа и базата — един "SELECT 1" — за да има какво да пита външен наблюдател.
#
# Подробностите за грешката остават в лога, не в отговора: адресът е публичен.
@app.get("/healthz", include_in_schema=False)
def healthz():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as err:  # noqa: BLE001 — каквото и да е, отвън е едно и също
        print(f"[healthz] базата не отговаря: {err!r}")
        return JSONResponse({"status": "degraded", "db": "down"}, status_code=503)
    # Email is reported but does NOT change the status code. A mail outage is
    # real and worth seeing, yet the app still works without it — waking someone
    # at night for it would teach them to ignore the alarm that matters.
    with SessionLocal() as db_session:
        ai_today = usage.today(db_session)
    return {"status": "ok", "db": "ok", "ai_today": ai_today, "email": email_service.delivery_status()["state"]}


@app.get("/")
def health():
    # Проста проверка, че сървърът е жив — отваряш адреса и виждаш това.
    return {"status": "ok"}


def _build_messages(images: list, history: list, question: str) -> list:
    """The conversation as Anthropic wants it: strictly alternating, images once.

    The photographs are the context of the whole conversation, not of each
    question, so they are attached to the FIRST student turn only. Two turns in
    a row from the same side are merged, and a history that opens with the
    assistant loses that turn — the API rejects both shapes, and the client is
    not trusted to get them right.
    """
    image_blocks = [
        {"type": "image", "source": {
            "type": "base64", "media_type": _image_media_type(img) or "image/jpeg", "data": img}}
        for img in images
    ]
    messages = []
    for turn in history:
        if not turn.text.strip():
            continue   # an empty text block is rejected by the API outright
        if messages and messages[-1]["role"] == turn.role:
            messages[-1]["content"].append({"type": "text", "text": turn.text})
        else:
            messages.append({"role": turn.role, "content": [{"type": "text", "text": turn.text}]})
    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"].append({"type": "text", "text": question})
    else:
        messages.append({"role": "user", "content": [{"type": "text", "text": question}]})
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    first_user = next(m for m in messages if m["role"] == "user")
    first_user["content"] = image_blocks + first_user["content"]
    return messages


# What the tutor is told about the student, and the rules for using it. Kept
# short on purpose: every token here is paid on every turn of every chat. The
# rules matter as much as the data — a tutor that opens with "I see you have
# three overdue tasks" is a nag, not a tutor.
# Where ClimbAI actually is. Without this the tutor knew the subject and nothing
# about the app around it: it could not say where Settings lives, it invented
# buttons when asked, and — worst — _student_context below has been handing it
# the phrase "their Route" for weeks without anything ever defining the word.
#
# The names here are the app's own, and a test keeps this list level with the
# screens that exist (test_the_tutor_knows_every_screen_the_app_has). Add a
# screen and the suite fails until this paragraph learns about it.
APP_MAP = {
    "en": """

Where you are. You are ClimbAI, inside Climby — a homework app for students in Bulgaria,
in Bulgarian and English. Everything below is named exactly as the student sees it.

The screens, from the menu on the left:
- "ClimbAI" — where a problem is photographed and worked through. Three ways in:
  "The camera here" (this computer's camera), "Your phone" (a linked
  phone — the better camera; the photo arrives here by itself), and "Past paper"
  (real national exam papers, НВО and матура, from earlier years). A picture can also be
  pasted with Ctrl+V or dropped straight onto the screen.
- "Ascent" — a timed focus session. The camera checks the student is still at the
  desk; nothing is recorded or sent anywhere, it only counts the minutes actually worked.
- "The Route" — the student's task list: what to do, for which subject, by when.
  Tasks are ticked off, edited by clicking the text, and a big one can be split into steps by
  you. A deleted task can be undone for a few seconds afterwards.
- "Summited" — everything already finished, and the questions asked here before.
- "Rope Team" — a parent, linked by a code. The parent sees how much was done and
  when, never what the tasks say and never these conversations.
- "Base Camp" — a teacher's class, joined by a code the teacher gives out.

There is also a chat panel — a small window opened by the round button in the bottom right
corner, on every screen. It is text only.

Settings opens full screen from the menu under the account name at the bottom left. Its rows,
in order:
- Appearance: "Language", "Theme",
  "Text size", "Reading" (wider letters and taller lines, easier
  with dyslexia).
- ClimbAI: "How ClimbAI explains" (hints first, or full solutions),
  "Read aloud" (only with the button, or every answer), "Voice"
  — the list of voices that can read answers aloud, each with a play button to hear it first.
  If the computer has no voice for the language, that row says so and explains where Windows
  adds one. Bulgarian has no voice on a stock Windows, so the read-aloud button does not
  appear at all there.
- The app: "Tour of the app", "Version" with
  "Check for updates", and "Linked phones".
- Account (only when signed in): "About you" (the grade,
  the town, and how they heard of Climby — asked once at the first sign-in),
  "Password", "Your data" (everything Climby keeps, as
  one file), and "Delete account", which asks for the password and is immediate.

Every screen has a "?" button beside its title that explains that screen.

If you are not sure where something is in the app, say so and point at the "?" button or at
Settings. Never invent a button, a screen or a menu item — a student sent looking for
something that does not exist trusts you less about the mathematics too.""",
    "bg": """

Къде се намираш. Ти си ClimbAI, вътре в Climby — приложение за домашни за ученици в България,
на български и английски. Всичко по-долу е наречено точно както го вижда ученикът.

Екраните, от менюто вляво:
- „ClimbAI" — тук се снима задача и се решава заедно. Три пътя: „Камерата тук"
  (камерата на този компютър), „Телефонът ти" (свързан телефон — по-добрата камера;
  снимката идва сама) и „Изпитен вариант" (истински изпитни варианти, НВО и матура, от
  предишни години). Снимка може и да се постави с Ctrl+V, или да се пусне върху екрана.
- „Възход" — сесия за фокус с часовник. Камерата проверява дали ученикът е още на
  бюрото; нищо не се записва и не се праща никъде, само се броят наистина работените минути.
- „Маршрут" — списъкът със задачи: какво, по кой предмет, докога. Задачите се
  отмятат, променят се с натискане върху текста, а голяма задача можеш да разделиш на стъпки.
  Изтрита задача може да се върне няколко секунди след това.
- „Изкачени" — всичко вече свършено и въпросите, задавани тук преди.
- „Свръзка" — родител, свързан с код. Родителят вижда колко е свършено и кога, никога
  какво пише в задачите и никога тези разговори.
- „Базата" — клас на учител, влиза се с код, който учителят дава.

Има и панел за разговор — малък прозорец, който се отваря с кръглото копче долу вдясно, на
всеки екран. Той е само текст.

Настройките се отварят на цял екран от менюто под името на акаунта долу вляво. Редовете им, по
ред:
- Изглед: „Език", „Тема",
  „Размер на текста", „Четене" (по-широки букви и редове, по-лесно при
  дислексия).
- ClimbAI: „Как обяснява ClimbAI" (подсказки или цяло решение),
  „Четене на глас" (само с бутона или всеки отговор), „Глас" —
  списък с гласовете, които могат да четат отговорите, всеки с копче за чуване. Ако компютърът
  няма глас за езика, редът го казва и обяснява откъде Windows добавя. На Windows по
  подразбиране няма български глас, затова там копчето за четене на глас изобщо не се показва.
- Приложението: „Разходка из приложението", „Версия" с
  „Провери за обновяване" и „Свързани телефони".
- Профил (само при влизане): „За теб" (класът, градът
  и откъде е чул за Climby — питат се веднъж при първото влизане),
  „Парола", „Твоите данни" (всичко, което Climby пази, в
  един файл) и „Изтриване на профила", което иска паролата и е незабавно.

Всеки екран има бутон „?" до заглавието, който обяснява този екран.

Ако не си сигурен къде е нещо в приложението, кажи го и посочи бутона „?" или Настройките.
Никога не измисляй бутон, екран или ред в менюто — ученик, пратен да търси нещо, което го няма,
ти вярва по-малко и за математиката.""",
}


# Which of the two places this question came from. They are genuinely different
# rooms: one can see photographs and the other cannot, and a tutor that does not
# know which room it is in will answer "let me look at your photo" to someone
# who has no way to send one.
SURFACE = {
    "chat": {
        "en": """

This message came from the chat panel — the small window on the side. You CANNOT see photographs
here; this conversation is text only, whatever the student says they have sent. If they want you
to look at a page, say so plainly and tell them to photograph it on the ClimbAI screen, where you
can. You can still work through a problem they type out.""",
        "bg": """

Този въпрос идва от панела за разговор — малкия прозорец отстрани. ТУК НЕ ВИЖДАШ снимки; този
разговор е само текст, каквото и да казва ученикът, че е пратил. Ако иска да погледнеш страница,
кажи му го направо и го прати да я снима на екрана ClimbAI, където можеш. Задача, която напише с
думи, спокойно можеш да решите заедно.""",
    },
    "tutor": {
        "en": """

This message came from the ClimbAI screen. There may be one or more photos of textbook pages (any
subject), or photos of a solution the student wrote themselves. When there's more than one photo
they are usually parts of the same problem (e.g. text continuing onto the next page) — read them
together unless they clearly look unrelated. With no photo the student is simply asking a
question — answer it the same way, by the same rules.""",
        "bg": """

Този въпрос идва от екрана ClimbAI. Може да има една или няколко снимки на страници от учебник (по
всеки предмет), или снимки на решение, което ученикът е написал сам. Ако снимките са повече от
една, обикновено са части от един и същ проблем (напр. продължение на текста на следваща страница)
— гледай ги заедно, освен ако не изглеждат явно несвързани. Без снимка ученикът просто задава
въпрос — отговаряй по същия начин, със същите правила.""",
    },
}


STUDENT_CONTEXT = {
    "en": (
        "\n\nWhat you know about this student (use it only when they ask about their "
        "homework, what to do next, or refer to something they asked before; never "
        "list it unprompted, never scold about deadlines):\n{block}"
    ),
    "bg": (
        "\n\nКакво знаеш за този ученик (използвай го само когато пита за домашните си, "
        "какво да прави след това, или се позовава на нещо, което е питал преди; никога "
        "не го изброявай без повод, никога не мъмри за срокове):\n{block}"
    ),
}
# Who the tutor is talking to. A first-grader and a tenth-grader can ask the
# same question and need different answers — not a dumber one and a smarter
# one, but different vocabulary, different length, a different amount of
# rigour. Without this the tutor spoke to everyone as if they were about ten.
GRADE_REGISTER = {
    "en": {
        (1, 4):  "The student is in grade {g} (age about {age}). Use short sentences and everyday words, one idea at a time, "
                 "concrete examples they can picture. Never a formula where a picture will do.",
        (5, 8):  "The student is in grade {g} (age about {age}). Be clear and concrete; name the rule and show it working; "
                 "define a term the first time you use it. Keep the tone friendly but don't talk down.",
        (9, 12): "The student is in grade {g} (age about {age}). Speak as you would to a capable young adult: precise "
                 "terminology, proper notation, the actual reasoning and the facts behind it, no simplification that "
                 "would be wrong at exam level. Assume they can follow a real argument.",
    },
    "bg": {
        (1, 4):  "Ученикът е в {g}. клас (около {age} г.). Кратки изречения, всекидневни думи, по една идея наведнъж, "
                 "примери, които може да си представи. Никога формула там, където стига картинка.",
        (5, 8):  "Ученикът е в {g}. клас (около {age} г.). Ясно и конкретно: назови правилото и го покажи в действие; "
                 "обясни термина първия път, когато го използваш. Приятелски тон, но без снизхождение.",
        (9, 12): "Ученикът е в {g}. клас (около {age} г.). Говори както на способен млад човек: точна терминология, "
                 "правилен запис, истинското разсъждение и фактите зад него, без опростяване, което би било грешно на "
                 "изпит. Приеми, че може да следва истинска аргументация.",
    },
}


def _grade_register(user, lang: str) -> str:
    g = getattr(user, "grade", None) if user else None
    if not g:
        return ""
    for (lo, hi), text_ in GRADE_REGISTER.get(lang, GRADE_REGISTER["en"]).items():
        if lo <= g <= hi:
            return "\n\n" + text_.format(g=g, age=g + 6)
    return ""


CONTEXT_MAX_TASKS = 10
CONTEXT_MAX_QUESTIONS = 6


def _student_context(db: Session, user: User, lang: str) -> str:
    """The Route and the recent questions, as a few lines — or nothing."""
    tasks = (db.query(Task)
             .filter(Task.user_id == user.id, Task.done.is_(False))
             .order_by(Task.deadline.is_(None), Task.deadline)
             .limit(CONTEXT_MAX_TASKS).all())
    recent = (db.query(ScanHistory)
              .filter(ScanHistory.user_id == user.id)
              .order_by(ScanHistory.created_at.desc())
              .limit(CONTEXT_MAX_QUESTIONS).all())
    if not tasks and not recent:
        return ""
    lines = []
    if tasks:
        lines.append("Pending tasks on their Route:" if lang == "en" else "Чакащи задачи в Маршрута:")
        for t in tasks:
            bits = [t.text[:120]]
            if t.subject:
                bits.append(t.subject[:40])
            if t.deadline:
                bits.append(("due " if lang == "en" else "срок ") + t.deadline.isoformat())
            lines.append("- " + " — ".join(bits))
    if recent:
        lines.append("Recent questions to you:" if lang == "en" else "Скорошни въпроси към теб:")
        for r in recent:
            lines.append("- " + r.question[:120].replace("\n", " "))
    return STUDENT_CONTEXT[lang].format(block="\n".join(lines))


@app.post("/ask")
def ask(
    body: Ask,
    request: Request,
    user: Optional[User] = Depends(auth.get_current_user_optional),
    db: Session = Depends(get_db),
):
    lang = body.lang if body.lang in SYSTEM else "en"
    # /ask е достъпен и за гости (без вход), затова лимитът е по IP, а не по акаунт —
    # пази от неограничени разходи за Anthropic API от един клиент/бот.
    # Разговорът значи повече реплики. С акаунт: 30 на час — един истински урок.
    # Гост остава на 12 по адрес: без акаунт няма по кого да броим.
    rate_limit.enforce(request, "ask", max_calls=30 if user else 12, window_seconds=3600,
                       message=RATE_LIMIT_MESSAGE[lang], user=user)
    # The day's budget, after the in-memory brake and never before it; a call
    # refused for budget gives its hit back. See usage.guard.
    usage.guard(db, lang, request, "ask", user)
    # Типът се взима от самата снимка, а не се предполага: приложението праща JPEG,
    # но качен от компютър файл спокойно може да е PNG и тогава "image/jpeg" е лъжа.
    messages = _build_messages(body.images, body.history, body.question)
    system = SYSTEM[lang] + (FULL_SOLUTIONS[lang] if body.mode == "full" else "")
    system += APP_MAP[lang]                     # what the app around it is
    system += SURFACE[body.surface][lang]       # and which room this is
    system += _grade_register(user, lang)       # every answer, photo or chat
    if body.context and user:
        system += _student_context(db, user, lang)
    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1500,
            system=system,
            messages=messages,
        )
    except APIError:
        raise HTTPException(502, ASK_ERROR_MESSAGE[lang])
    usage.record(db, resp)
    answer = "".join(b.text for b in resp.content if b.type == "text")

    if user:
        # Пазим само текста на въпроса/отговора за историята — снимките, стигнали дотук, не се записват.
        # Best effort, like the token count above it: the answer is already
        # bought, and a database hiccup here must not throw it away as a 500.
        try:
            db.add(ScanHistory(user_id=user.id, question=body.question, answer=answer, lang=lang))
            db.commit()
        except Exception as err:  # noqa: BLE001
            db.rollback()
            print(f"[ask] could not save to history: {err!r}", flush=True)

    return {"answer": answer}
