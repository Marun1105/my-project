# server.py — бекендът. Пази API ключа, говори с Anthropic, пази базата данни, отговаря на браузъра.
#
# Локално:   python -m uvicorn server:app --reload
# На Render:  Render използва Start Command-а автоматично (виж по-долу).
#
# Инсталиране локално:  pip install -r requirements.txt
from dotenv import load_dotenv
load_dotenv()  # трябва да е преди другите импорти, за да заредят env променливите навреме

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from anthropic import Anthropic

import auth
import planner
import tasks
from db import Base, engine

app = FastAPI()
client = Anthropic()  # чете ANTHROPIC_API_KEY от средата

Base.metadata.create_all(bind=engine)

app.include_router(auth.router)
app.include_router(tasks.router)
app.include_router(planner.router)

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
Пред теб е снимка на страница от учебник (по всеки предмет — математика, български, природни науки,
история и т.н.), или снимка на решение, което ученикът е написал сам.

Правила:
- Обяснявай на български, стъпка по стъпка, ясно и просто, на ниво, подходящо за ученика.
- Не давай само отговора — покажи как се стига до него, за да се научи ученикът.
- Ако ученикът е снимал свое решение, провери го и посочи точно къде е сгрешил — насърчаващо, не строго.
- Ако предметът не е подходящ за обяснение чрез снимка на страница (напр. физическо възпитание,
  практическо музикално изпълнение), кажи го учтиво, вместо да отгатваш отговор.
- Можеш да използваш Markdown и LaTeX между $...$ или $$...$$ — отговорът се показва в браузър.""",
    "en": """You are a teacher helping students from grade 1 to grade 12 with their homework.
You're shown a photo of a textbook page (any subject — math, language arts, science, history, etc.),
or a photo of a solution the student wrote themselves.

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
    image_base64: str
    question: str
    lang: str = "bg"


@app.get("/")
def health():
    # Проста проверка, че сървърът е жив — отваряш адреса и виждаш това.
    return {"status": "ok"}


@app.post("/ask")
def ask(body: Ask):
    lang = body.lang if body.lang in SYSTEM else "bg"
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1500,
        system=SYSTEM[lang],
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": body.image_base64,
                }},
                {"type": "text", "text": body.question},
            ],
        }],
    )
    answer = "".join(b.text for b in resp.content if b.type == "text")
    return {"answer": answer}
