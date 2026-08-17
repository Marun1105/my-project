# planner.py — AI помощник за плана: гледа чеклиста и предлага как да се организира работата
from typing import List, Optional

from anthropic import Anthropic, APIStatusError
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

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


class TaskIn(BaseModel):
    text: str
    subject: Optional[str] = None
    deadline: Optional[str] = None


class PlanRequest(BaseModel):
    tasks: List[TaskIn]
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
    except APIStatusError:
        raise HTTPException(502, PLAN_ERROR_MESSAGE[lang])
    advice = "".join(b.text for b in resp.content if b.type == "text")
    return {"advice": advice}
