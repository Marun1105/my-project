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

# Паролата по подразбиране стои тук нарочно — тя важи само за файла на този
# компютър. За всяка друга база _resolve_target() иска CLIMBY_DEMO_PASSWORD и
# отказва без нея, защото това тук е публично четимо.
PASSWORD = os.environ.get("CLIMBY_DEMO_PASSWORD") or "climby1234"

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


DEFAULT_LOCAL = "sqlite:///./climby.db"


def _resolve_target():
    """Коя база ще пипнем — и имаме ли право.

    Първата версия на тази проверка гледаше схемата: "sqlite значи локално".
    Това е грешно и опасно. db.py пада на точно същия sqlite:///./climby.db,
    когато DATABASE_URL липсва — включително в Render. Тоест продукция, която
    върви на този резервен вариант, минаваше за "локална" и скриптът щеше да
    ѝ сложи акаунти с парола, която стои публично в хранилището.

    По адреса не може да се познае чия е базата. Затова правилото е просто:
    без DATABASE_URL пипаме файла до нас и толкова; има ли DATABASE_URL —
    каквато и да е — искаме изрично разрешение. А публичната парола не отива
    никъде другаде освен на този файл, при никакви обстоятелства.
    """
    raw = os.environ.get("DATABASE_URL")
    if not raw or not raw.strip():
        return DEFAULT_LOCAL, False

    if "--yes-production" not in sys.argv:
        print("Отказвам: зададен е DATABASE_URL, тоест базата може да не е тази на")
        print("този компютър, а по адреса не може да се разбере чия е.")
        print("Ако наистина искаш демо акаунти там, добави --yes-production.")
        sys.exit(1)

    if not os.environ.get("CLIMBY_DEMO_PASSWORD"):
        print("Отказвам: паролата по подразбиране стои в хранилището и всеки може")
        print("да я прочете. За чужда база задай своя:")
        print('  $env:CLIMBY_DEMO_PASSWORD = "..."')
        sys.exit(1)

    return raw.strip(), True


def main():
    url, foreign = _resolve_target()
    print("база:", url.split("@")[-1] if foreign else f"локалният файл {DEFAULT_LOCAL}")
    if foreign:
        print("ВНИМАНИЕ: не е базата по подразбиране — пише се по изрично разрешение.")
    print()
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

        if os.environ.get("CLIMBY_DEMO_PASSWORD"):
            print("\nПарола: тази от CLIMBY_DEMO_PASSWORD (нарочно не се печата).")
        else:
            print(f"\nПарола за трите акаунта: {PASSWORD}")
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
