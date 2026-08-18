# planner.py — AI помощник за плана: гледа чеклиста и предлага как да се организира работата
import json
from typing import List, Optional

from anthropic import Anthropic, APIError
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import rate_limit

router = APIRouter(prefix="/plan", tags=["plan"])
client = Anthropic()  # чете ANTHROPIC_API_KEY от средата

RATE_LIMIT_MESSAGE = {
    "bg": "Твърде много опити за кратко време — изчакай малко и опитай пак.",
    "en": "Too many requests in a short time — please wait a bit and try again.",
}

SYSTEM = {
    "bg": """Ти си вдъхновяващ помощник, който помага на ученик (1-12 клас) да организира домашните си.
Пред теб е списък със задачите на ученика: текст, предмет (ако е зададен) и срок (ако е зададен).

Дай кратък, конкретен съвет:
- Кое да започне първо и защо (най-спешното или най-голямото)
- Как да раздели голяма задача на по-малки части, ако личи, че е голяма
- Насърчаващ, топъл тон — никога строг или притеснен

Пиши кратко (3-6 изречения), на български, директно към ученика (напр. "Започни с...", "Раздели...").
Можеш да ползваш Markdown за структура (напр. списък), но без заглавия.""",
    "en": """You are an encouraging assistant helping a student (grades 1-12) organize their homework.
You're given a list of the student's tasks: text, subject (if given), and deadline (if given).

Give brief, concrete advice:
- What to start with first and why (most urgent or biggest)
- How to break a big task into smaller parts, if it looks large
- Encouraging, warm tone — never strict or anxious

Write briefly (3-6 sentences), in English, speaking directly to the student (e.g. "Start with...", "Break...").
You can use Markdown for structure (e.g. a list), but no headings.""",
}

NO_TASKS_MESSAGE = {
    "bg": "Няма чакащи задачи в чеклиста — добави някоя, за да получиш съвет как да я организираш.",
    "en": "There are no pending tasks in the checklist — add one to get advice on how to organize it.",
}

PLAN_ERROR_MESSAGE = {
    "bg": "Нещо се обърка при съставянето на съвета. Опитай пак след малко.",
    "en": "Something went wrong putting the advice together. Try again shortly.",
}


SPLIT_SYSTEM = {
    "bg": """Ти разделяш една училищна задача на 2-5 по-малки, конкретни стъпки.
Всяка стъпка трябва да е нещо, което ученикът може да отметне за 10-30 минути.
Отговори САМО с JSON масив от текстове, без обяснения и без Markdown, например:
["Прочети текста на стр. 32", "Реши задачи 4-6", "Провери отговорите"]
Пиши на български, кратко и конкретно.""",
    "en": """You split one school task into 2-5 smaller, concrete steps.
Each step should be something the student can tick off in 10-30 minutes.
Reply with ONLY a JSON array of strings, no explanation and no Markdown, e.g.:
["Read the text on p. 32", "Solve exercises 4-6", "Check the answers"]
Write in English, short and concrete.""",
}

SPLIT_ERROR_MESSAGE = {
    "bg": "Не успях да разделя задачата. Опитай пак след малко.",
    "en": "Couldn't split the task. Try again shortly.",
}


class TaskIn(BaseModel):
    text: str = Field(max_length=500)
    subject: Optional[str] = Field(default=None, max_length=100)
    deadline: Optional[str] = Field(default=None, max_length=32)


class PlanRequest(BaseModel):
    # /plan и /split са отворени и без вход, затова тук стои таванът на разхода.
    tasks: List[TaskIn] = Field(max_length=50)
    lang: str = "bg"


class SplitRequest(BaseModel):
    text: str = Field(max_length=1000)
    subject: Optional[str] = Field(default=None, max_length=100)
    lang: str = "bg"


@router.post("")
def plan(body: PlanRequest, request: Request):
    lang = body.lang if body.lang in SYSTEM else "bg"

    if not body.tasks:
        return {"advice": NO_TASKS_MESSAGE[lang]}

    rate_limit.enforce(request, "plan", max_calls=20, window_seconds=3600, message=RATE_LIMIT_MESSAGE[lang])

    lines = []
    for t in body.tasks:
        parts = [t.text]
        if t.subject:
            parts.append(f"subject: {t.subject}")
        if t.deadline:
            parts.append(f"deadline: {t.deadline}")
        lines.append("- " + ", ".join(parts))
    tasks_text = "\n".join(lines)

    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=500,
            system=SYSTEM[lang],
            messages=[{"role": "user", "content": f"My tasks:\n{tasks_text}"}],
        )
    except APIError:
        raise HTTPException(502, PLAN_ERROR_MESSAGE[lang])
    advice = "".join(b.text for b in resp.content if b.type == "text")
    return {"advice": advice}


@router.post("/split")
def split(body: SplitRequest, request: Request):
    lang = body.lang if body.lang in SPLIT_SYSTEM else "bg"
    text = body.text.strip()
    if not text:
        raise HTTPException(400, SPLIT_ERROR_MESSAGE[lang])

    rate_limit.enforce(request, "split", max_calls=20, window_seconds=3600, message=RATE_LIMIT_MESSAGE[lang])

    prompt = text if not body.subject else f"{text} (subject: {body.subject})"
    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            system=SPLIT_SYSTEM[lang],
            messages=[{"role": "user", "content": prompt}],
        )
    except APIError:
        raise HTTPException(502, SPLIT_ERROR_MESSAGE[lang])

    raw = "".join(b.text for b in resp.content if b.type == "text").strip()
    # моделът понякога обгражда JSON-а с ```json ... ``` въпреки инструкцията
    if raw.startswith("```"):
        raw = raw.split("```")[1] if "```" in raw[3:] else raw.strip("`")
        raw = raw.removeprefix("json").strip()

    try:
        steps = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(502, SPLIT_ERROR_MESSAGE[lang])

    if not isinstance(steps, list):
        raise HTTPException(502, SPLIT_ERROR_MESSAGE[lang])

    clean = [str(s).strip() for s in steps if str(s).strip()][:5]
    if not clean:
        raise HTTPException(502, SPLIT_ERROR_MESSAGE[lang])
    return {"steps": clean}
