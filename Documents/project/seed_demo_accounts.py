# seed_demo_accounts.py — прави три готови акаунта (ученик, родител, учител),
# за да може всеки изглед да се отвори и погледне, без да се минава през
# истинска регистрация с код по имейл.
#
# Пускане (локално, върху базата от .env или climby.db):
#     python seed_demo_accounts.py
#
# Скриптът може да се пуска колкото пъти трябва — не дублира нищо, а обновява.
# Нарочно НЕ се пуска сам отникъде и НЕ пипа продукцията, освен ако DATABASE_URL
# изрично не сочи натам.
import os
import sys
from datetime import date, timedelta

from dotenv import load_dotenv

load_dotenv()

import classes  # noqa: E402  (за истинския генератор на код за клас)
import migrations  # noqa: E402
import security  # noqa: E402
from db import Base, SessionLocal, engine  # noqa: E402
from models import (  # noqa: E402
    Classroom,
    ClassroomMember,
    FamilyLink,
    FocusSession,
    Role,
    Task,
    User,
)

PASSWORD = "climby1234"

# Домейнът не е .test нарочно: email-validator отказва запазените домейни
# (.test/.example/.invalid/.localhost) и входът връща 422, макар редът в базата
# да изглежда наред. Никой не праща поща насам — важното е да е валиден адрес.
ACCOUNTS = [
    ("student@climbydemo.bg", "Марти", Role.student),
    ("parent@climbydemo.bg", "Мама на Марти", Role.parent),
    ("teacher@climbydemo.bg", "Г-жа Иванова", Role.teacher),
]

# Остатъци от по-ранен опит със запазен домейн — махат се, за да не се трупат.
STALE_EMAILS = ["student@climby.test", "parent@climby.test", "teacher@climby.test"]

# Задачи с различни предмети — долната лента с предметите има какво да покаже
# само ако наистина има предмети.
TASKS = [
    ("Упражнение 5, стр. 42", "Математика", 1, False),
    ("Задачи 1-4 за дроби", "Математика", 3, False),
    ("Съчинение за Ботев", "Български език", 2, False),
    ("Да прочета глава 3", "Литература", 5, False),
    ("Опит с магнити — да опиша", "Човекът и природата", 0, False),
    ("Карта на Тракия", "История", -1, False),
    ("Думи от урок 7", "Английски език", 4, False),
    ("Упражнение 3, стр. 38", "Математика", -3, True),
    ("Преразказ", "Български език", -2, True),
]


def _upsert_user(db, email, name, role):
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        user = User(display_name=name, email=email, role=role.value,
                    password_hash=security.hash_password(PASSWORD))
        db.add(user)
        action = "създаден"
    else:
        user.display_name = name
        user.role = role.value
        user.password_hash = security.hash_password(PASSWORD)
        action = "обновен"
    user.is_email_verified = True  # без това входът връща 403
    db.commit()
    db.refresh(user)
    return user, action


def _refuse_production():
    # Скриптът слага акаунти с публично известна парола. На истинската база това
    # е дупка, не удобство — затова тръгва само срещу локална база, освен ако
    # някой изрично не напише --yes-production.
    url = os.environ.get("DATABASE_URL") or "sqlite:///./climby.db"
    local = url.startswith("sqlite") or "localhost" in url or "127.0.0.1" in url
    if local or "--yes-production" in sys.argv:
        return url
    print("Отказвам: DATABASE_URL не сочи локална база.")
    print(f"  {url.split('@')[-1]}")
    print("Ако наистина искаш демо акаунти там, добави --yes-production.")
    sys.exit(1)


def main():
    url = _refuse_production()
    print(f"база: {url.split('@')[-1]}\n")
    Base.metadata.create_all(bind=engine)
    # create_all прави липсващите таблици, но не и липсващите колони в стари
    # бази — точно затова съществува migrations.py. Стар climby.db без users.role
    # иначе гърми още на първата заявка.
    applied = migrations.run()
    if applied:
        print("миграции:", ", ".join(applied))
    db = SessionLocal()
    try:
        for email in STALE_EMAILS:
            stale = db.query(User).filter(User.email == email).first()
            if stale:
                db.query(Task).filter(Task.user_id == stale.id).delete()
                db.query(FocusSession).filter(FocusSession.user_id == stale.id).delete()
                db.query(FamilyLink).filter(
                    (FamilyLink.parent_user_id == stale.id) | (FamilyLink.student_user_id == stale.id)
                ).delete(synchronize_session=False)
                db.query(ClassroomMember).filter(ClassroomMember.student_user_id == stale.id).delete()
                for room in db.query(Classroom).filter(Classroom.teacher_user_id == stale.id).all():
                    db.query(ClassroomMember).filter(ClassroomMember.classroom_id == room.id).delete()
                    db.delete(room)
                db.delete(stale)
                db.commit()
                print(f"махнат стар демо акаунт {email}")

        made = {}
        for email, name, role in ACCOUNTS:
            user, action = _upsert_user(db, email, name, role)
            made[role] = user
            print(f"{role.value:8s} {email:24s} {action}")

        student, parent, teacher = made[Role.student], made[Role.parent], made[Role.teacher]

        # Домашни на ученика — трият се и се слагат наново, за да е един и същ
        # изгледът при всяко пускане.
        db.query(Task).filter(Task.user_id == student.id).delete()
        today = date.today()
        for text, subject, in_days, done in TASKS:
            db.add(Task(user_id=student.id, text=text, subject=subject,
                        deadline=today + timedelta(days=in_days), done=done,
                        completed_at=None))
        db.commit()
        print(f"\n{len(TASKS)} задачи за {student.display_name} "
              f"({len({t[1] for t in TASKS})} предмета)")

        # Родителят вижда ученика.
        if not db.query(FamilyLink).filter(
            FamilyLink.parent_user_id == parent.id,
            FamilyLink.student_user_id == student.id,
        ).first():
            db.add(FamilyLink(parent_user_id=parent.id, student_user_id=student.id))
            db.commit()
            print("родителят е свързан с ученика")

        # Клас на учителя, с ученика вътре.
        classroom = db.query(Classroom).filter(Classroom.teacher_user_id == teacher.id).first()
        if classroom is None:
            classroom = Classroom(teacher_user_id=teacher.id, name="7В клас",
                                  join_code=classes._generate_code(db))
            db.add(classroom)
            db.commit()
            db.refresh(classroom)
            print(f"клас '{classroom.name}' с код {classroom.join_code}")
        if not db.query(ClassroomMember).filter(
            ClassroomMember.classroom_id == classroom.id,
            ClassroomMember.student_user_id == student.id,
        ).first():
            db.add(ClassroomMember(classroom_id=classroom.id, student_user_id=student.id))
            db.commit()
            print("ученикът е в класа")

        # Малко фокус история, за да не са нули в изгледите на родителя и учителя.
        if not db.query(FocusSession).filter(FocusSession.user_id == student.id).first():
            for minutes, pct in ((25, 82), (40, 74), (15, 91)):
                db.add(FocusSession(user_id=student.id, duration_seconds=minutes * 60, focus_pct=pct))
            db.commit()
            print("добавени 3 фокус сесии")

        print(f"\nПарола за трите акаунта: {PASSWORD}")
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
