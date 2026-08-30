# tasks.py — CRUD за задачите в чеклиста, обвързани с акаунта на ученика
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import rate_limit
from auth import get_current_user
from db import get_db
from models import Task, User
from schemas import TaskIn, TaskOut, TaskUpdate

router = APIRouter(prefix="/tasks", tags=["tasks"])

# Единственият ендпойнт, който пише неограничено в базата по желание на клиента.
# Лимитът е по IP, а цял компютърен кабинет в училище излиза през един адрес —
# затова е нарочно висок: 200 на час е далеч над всичко, което трийсет ученици
# ще напишат, но заедно с тавана от 2000 знака свежда най-лошия случай до
# около 400 KB на час от един адрес вместо гигабайти.
MAX_TASKS_PER_HOUR = 200


@router.get("", response_model=List[TaskOut])
def list_tasks(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.query(Task)
        .filter(Task.user_id == user.id)
        .order_by(Task.done, Task.deadline.is_(None), Task.deadline)
        .all()
    )


@router.post("", response_model=TaskOut)
def create_task(
    body: TaskIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rate_limit.enforce(request, "task-create", max_calls=MAX_TASKS_PER_HOUR, window_seconds=3600,
                       message="Твърде много задачи за кратко време — изчакай малко.")
    task = Task(user_id=user.id, text=body.text, subject=body.subject, deadline=body.deadline)
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.patch("/{task_id}", response_model=TaskOut)
def update_task(
    task_id: str,
    body: TaskUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == user.id).first()
    if not task:
        raise HTTPException(404, "Задачата не е намерена.")

    data = body.model_dump(exclude_unset=True)
    was_done = task.done
    for field, value in data.items():
        setattr(task, field, value)
    if "done" in data and data["done"] != was_done:
        task.completed_at = datetime.now(timezone.utc) if data["done"] else None

    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}")
def delete_task(task_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == user.id).first()
    if not task:
        raise HTTPException(404, "Задачата не е намерена.")
    db.delete(task)
    db.commit()
    return {"status": "ok"}
