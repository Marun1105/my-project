# classes.py — класове на учител: учителят прави клас, казва кода на учениците,
# те се присъединяват и той вижда обобщения напредък на целия клас.
#
# Разликата с родителския изглед (family.py) е в мащаба, не в правата: родителят
# се свързва с едно дете чрез еднократен код, учителят има много ученици наведнъж
# и кодът му е дълготраен. Какво СЕ ВИЖДА е едно и също — само числа, никога текст
# на задача или въпрос към AI учителя.
import secrets
from collections import defaultdict
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import rate_limit
from auth import get_current_user
from db import get_db
from family import _progress_by_student, _progress_out, _users_by_id
from models import Classroom, ClassroomMember, Role, User
from schemas import (
    ClassroomCreate,
    ClassroomJoinRequest,
    ClassroomOut,
    ClassroomWithStudents,
)

router = APIRouter(prefix="/classes", tags=["classes"])

# същата азбука като родителските кодове — без 0/O/1/I, защото кодът се диктува на глас
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6
MAX_CLASSES_PER_TEACHER = 30


def _require_teacher(user: User) -> User:
    if user.role != Role.teacher.value:
        raise HTTPException(403, "Само учителски акаунт може да прави класове.")
    return user


def _generate_code(db: Session) -> str:
    for _ in range(10):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if not db.query(Classroom).filter(Classroom.join_code == code).first():
            return code
    raise HTTPException(500, "Не успях да създам код за класа. Опитай пак.")


@router.post("", response_model=ClassroomOut)
def create_class(
    body: ClassroomCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_teacher(user)
    rate_limit.enforce(request, "class-create", max_calls=20, window_seconds=3600,
                       message="Твърде много класове за кратко време — изчакай малко.")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Класът трябва да има име.")

    count = db.query(Classroom).filter(Classroom.teacher_user_id == user.id).count()
    if count >= MAX_CLASSES_PER_TEACHER:
        raise HTTPException(400, "Достигна максималния брой класове.")

    classroom = Classroom(teacher_user_id=user.id, name=name, join_code=_generate_code(db))
    db.add(classroom)
    db.commit()
    db.refresh(classroom)
    return ClassroomOut(
        id=classroom.id, name=classroom.name, join_code=classroom.join_code,
        student_count=0, created_at=classroom.created_at,
    )


@router.get("", response_model=List[ClassroomWithStudents])
def list_classes(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(user)
    classrooms = db.query(Classroom).filter(Classroom.teacher_user_id == user.id).all()
    if not classrooms:
        return []

    # Целият изглед се събира с шепа заявки: членовете на всички класове наведнъж,
    # после самите ученици, после броевете им. Досега тук се въртеше цикъл в цикъл
    # и всеки ученик струваше отделни обиколки до базата.
    members = (
        db.query(ClassroomMember)
        .filter(ClassroomMember.classroom_id.in_([c.id for c in classrooms]))
        .order_by(ClassroomMember.created_at)
        .all()
    )
    students = _users_by_id(db, (m.student_user_id for m in members))
    numbers = _progress_by_student(db, students)

    by_class = defaultdict(list)
    for member in members:
        student = students.get(member.student_user_id)
        if student:
            by_class[member.classroom_id].append(
                _progress_out(student, member.created_at, numbers[student.id])
            )

    return [
        ClassroomWithStudents(
            id=classroom.id, name=classroom.name, join_code=classroom.join_code,
            student_count=len(by_class[classroom.id]), created_at=classroom.created_at,
            students=by_class[classroom.id],
        )
        for classroom in classrooms
    ]


@router.post("/join")
def join_class(
    body: ClassroomJoinRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rate_limit.enforce(request, "class-join", max_calls=15, window_seconds=3600,
                       message="Твърде много опити с код — изчакай малко и опитай пак.")
    code = body.code.strip().upper()
    classroom = db.query(Classroom).filter(Classroom.join_code == code).first()
    if not classroom:
        raise HTTPException(400, "Няма клас с този код. Провери го при учителя си.")
    if classroom.teacher_user_id == user.id:
        raise HTTPException(400, "Не можеш да се присъединиш към собствения си клас.")

    existing = db.query(ClassroomMember).filter(
        ClassroomMember.classroom_id == classroom.id,
        ClassroomMember.student_user_id == user.id,
    ).first()
    if existing:
        raise HTTPException(400, "Вече си в този клас.")

    db.add(ClassroomMember(classroom_id=classroom.id, student_user_id=user.id))
    db.commit()
    return {"status": "ok", "class_name": classroom.name}


@router.get("/mine")
def my_classes(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Ученикът вижда в кои класове е и кой учител го вижда — и може да излезе."""
    members = db.query(ClassroomMember).filter(ClassroomMember.student_user_id == user.id).all()
    out = []
    for member in members:
        classroom = db.get(Classroom, member.classroom_id)
        if not classroom:
            continue
        teacher = db.get(User, classroom.teacher_user_id)
        out.append({
            "class_id": classroom.id,
            "name": classroom.name,
            "teacher_name": teacher.display_name if teacher else "—",
            "joined_at": member.created_at,
        })
    return out


@router.delete("/mine/{class_id}")
def leave_class(class_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    member = db.query(ClassroomMember).filter(
        ClassroomMember.classroom_id == class_id,
        ClassroomMember.student_user_id == user.id,
    ).first()
    if not member:
        raise HTTPException(404, "Не си в този клас.")
    db.delete(member)
    db.commit()
    return {"status": "ok"}


@router.delete("/{class_id}/students/{student_id}")
def remove_student(
    class_id: str,
    student_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_teacher(user)
    classroom = db.query(Classroom).filter(
        Classroom.id == class_id, Classroom.teacher_user_id == user.id
    ).first()
    if not classroom:
        raise HTTPException(404, "Няма такъв клас.")
    member = db.query(ClassroomMember).filter(
        ClassroomMember.classroom_id == class_id,
        ClassroomMember.student_user_id == student_id,
    ).first()
    if not member:
        raise HTTPException(404, "Ученикът не е в този клас.")
    db.delete(member)
    db.commit()
    return {"status": "ok"}


@router.delete("/{class_id}")
def delete_class(class_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _require_teacher(user)
    classroom = db.query(Classroom).filter(
        Classroom.id == class_id, Classroom.teacher_user_id == user.id
    ).first()
    if not classroom:
        raise HTTPException(404, "Няма такъв клас.")
    db.query(ClassroomMember).filter(ClassroomMember.classroom_id == class_id).delete()
    db.delete(classroom)
    db.commit()
    return {"status": "ok"}
