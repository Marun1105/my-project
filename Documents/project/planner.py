# planner.py — AI помощник за плана: гледа чеклиста и предлага как да се организира работата
from typing import List, Optional

from anthropic import Anthropic
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/plan", tags=["plan"])
client = Anthropic()  # чете ANTHROPIC_API_KEY от средата

SYSTEM = """Ти си вдъхновяващ помощник, който помага на ученик (1-12 клас) да организира домашните си.
Пред теб е списък със задачите на ученика: текст, предмет (ако е зададен) и срок (ако е зададен).

Дай кратък, конкретен съвет:
- Кое да започне първо и защо (най-спешното или най-голямото)
- Как да раздели голяма задача на по-малки части, ако личи, че е голяма
- Насърчаващ, топъл тон — никога строг или притеснен

Пиши кратко (3-6 изречения), на български, директно към ученика (напр. "Започни с...", "Раздели...").
Можеш да ползваш Markdown за структура (напр. списък), но без заглавия."""


class TaskIn(BaseModel):
    text: str
    subject: Optional[str] = None
    deadline: Optional[str] = None


class PlanRequest(BaseModel):
    tasks: List[TaskIn]


@router.post("")
def plan(body: PlanRequest):
    if not body.tasks:
        return {"advice": "Няма чакащи задачи в чеклиста — добави някоя, за да получиш съвет как да я организираш."}

    lines = []
    for t in body.tasks:
        parts = [t.text]
        if t.subject:
            parts.append(f"предмет: {t.subject}")
        if t.deadline:
            parts.append(f"срок: {t.deadline}")
        lines.append("- " + ", ".join(parts))
    tasks_text = "\n".join(lines)

    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=500,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"Задачите ми:\n{tasks_text}"}],
    )
    advice = "".join(b.text for b in resp.content if b.type == "text")
    return {"advice": advice}
