# server.py — бекендът. Пази API ключа, говори с Anthropic, пази базата данни, отговаря на браузъра.
#
# Локално:   python -m uvicorn server:app --reload
# На Render:  Render използва Start Command-а автоматично (виж по-долу).
#
# Инсталиране локално:  pip install -r requirements.txt
from dotenv import load_dotenv
load_dotenv()  # трябва да е преди другите импорти, за да заредят env променливите навреме

from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from anthropic import Anthropic, APIStatusError
from sqlalchemy.orm import Session

import auth
import planner
import rate_limit
import scans
import tasks
from db import Base, engine, get_db
from models import ScanHistory, User

app = FastAPI()
client = Anthropic()  # чете ANTHROPIC_API_KEY от средата

Base.metadata.create_all(bind=engine)

app.include_router(auth.router)
app.include_router(tasks.router)
app.include_router(planner.router)
app.include_router(scans.router)

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


class Ask(BaseModel):
    images: List[str]
    question: str
    lang: str = "bg"


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
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img}}
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
    except APIStatusError:
        raise HTTPException(502, ASK_ERROR_MESSAGE[lang])
    answer = "".join(b.text for b in resp.content if b.type == "text")

    if user:
        # Пазим само текста на въпроса/отговора за историята — снимките никога не се записват.
        db.add(ScanHistory(user_id=user.id, question=body.question, answer=answer, lang=lang))
        db.commit()

    return {"answer": answer}
