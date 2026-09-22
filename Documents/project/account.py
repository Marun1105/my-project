# account.py — the account itself: change the password, take your data, leave.
#
# auth.py gets you in. This is what you can do about the account once you are:
# the three things a person is entitled to ask of an app that holds their data,
# and that a children's app in particular has to be able to answer without a
# human running a database query. Until now the only answer to "delete my
# child's account" was exactly that.
#
# Deletion is total and immediate. Nothing is soft-deleted or kept "for a
# while": the privacy policy says what is stored, and after this nothing is.
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import rate_limit
import security
from auth import get_current_user
from db import get_db
from models import (
    ClassroomMember, Classroom, CodeAttempt, FamilyInvite, FamilyLink, FocusSession,
    OAuthIdentity, PairRequest, PairedDevice, PhonePhoto, ScanHistory, Task, User,
    VerificationCode,
)
from schemas import UserOut

router = APIRouter(prefix="/account", tags=["account"])


# ---------------------------------------------------------------------------
# password
# ---------------------------------------------------------------------------

class PasswordChange(BaseModel):
    # None is allowed on purpose: an account made with Google has no password
    # yet, and setting a first one is how it gains a second way in.
    current_password: Optional[str] = Field(default=None, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class PasswordChanged(BaseModel):
    token: str
    user: UserOut


@router.post("/password", response_model=PasswordChanged)
def change_password(
    body: PasswordChange,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rate_limit.enforce(request, "password-change", max_calls=10, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.", user=user)
    if user.password_hash:
        if not body.current_password or not security.verify_password(body.current_password, user.password_hash):
            # The same words as a wrong sign-in: nothing here should read
            # differently to someone holding a stolen session.
            raise HTTPException(400, "Incorrect email or password.")
    user.password_hash = security.hash_password(body.new_password)
    # Every other session is ended. Whoever else held a token — a shared
    # tablet, a stolen one — is out; this one continues with a fresh token.
    user.token_version = int(user.token_version or 0) + 1
    db.commit()
    db.refresh(user)
    return PasswordChanged(
        token=security.create_access_token(user.id, user.token_version),
        user=UserOut.model_validate(user),
    )


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------

def _iso(dt) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, datetime) and dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


@router.get("/export")
def export_data(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Everything stored about this account, as one JSON file.

    Plain, readable, and complete: a person should be able to open it and see
    exactly what the privacy policy said would be there — and nothing that it
    said would not, which is why photos and other people's names are absent
    except where the person themselves made the link.
    """
    rate_limit.enforce(request, "export", max_calls=6, window_seconds=3600,
                       message="Too many exports in a short time. Please wait a moment.", user=user)

    tasks = db.query(Task).filter(Task.user_id == user.id).order_by(Task.created_at).all()
    scans = db.query(ScanHistory).filter(ScanHistory.user_id == user.id).order_by(ScanHistory.created_at).all()
    sessions = db.query(FocusSession).filter(FocusSession.user_id == user.id).order_by(FocusSession.created_at).all()
    parents = (db.query(User.display_name, FamilyLink.created_at)
               .join(FamilyLink, FamilyLink.parent_user_id == User.id)
               .filter(FamilyLink.student_user_id == user.id).all())
    students = (db.query(User.display_name, FamilyLink.created_at)
                .join(FamilyLink, FamilyLink.student_user_id == User.id)
                .filter(FamilyLink.parent_user_id == user.id).all())
    classes_in = (db.query(Classroom.name, ClassroomMember.created_at)
                  .join(ClassroomMember, ClassroomMember.classroom_id == Classroom.id)
                  .filter(ClassroomMember.student_user_id == user.id).all())
    classes_own = db.query(Classroom).filter(Classroom.teacher_user_id == user.id).all()
    devices = db.query(PairedDevice).filter(PairedDevice.user_id == user.id).all()
    identities = db.query(OAuthIdentity).filter(OAuthIdentity.user_id == user.id).all()

    data = {
        "exported_at": _iso(datetime.now(timezone.utc)),
        "account": {
            "display_name": user.display_name,
            "username": user.username,
            "email": user.email,
            "phone": user.phone,
            "role": user.role,
            "created_at": _iso(user.created_at),
            "sign_in_providers": ["password"] * bool(user.password_hash) + [i.provider for i in identities],
        },
        "tasks": [{
            "text": t.text, "subject": t.subject, "deadline": t.deadline.isoformat() if t.deadline else None,
            "done": bool(t.done), "created_at": _iso(t.created_at), "completed_at": _iso(t.completed_at),
        } for t in tasks],
        "questions": [{
            "question": s.question, "answer": s.answer, "lang": s.lang, "asked_at": _iso(s.created_at),
        } for s in scans],
        "study_sessions": [{
            "duration_seconds": s.duration_seconds, "focus_pct": s.focus_pct, "at": _iso(s.created_at),
        } for s in sessions],
        "rope_team": {
            "parents_with_access": [{"name": n, "since": _iso(at)} for n, at in parents],
            "students_i_see": [{"name": n, "since": _iso(at)} for n, at in students],
        },
        "classes": {
            "member_of": [{"name": n, "since": _iso(at)} for n, at in classes_in],
            "teaching": [{"name": c.name, "created_at": _iso(c.created_at)} for c in classes_own],
        },
        "linked_phones": [{"name": d.name, "since": _iso(d.created_at)} for d in devices],
    }
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return JSONResponse(data, headers={
        "Content-Disposition": f'attachment; filename="climby-export-{stamp}.json"',
        "Cache-Control": "no-store",
    })


# ---------------------------------------------------------------------------
# deletion
# ---------------------------------------------------------------------------

class DeleteAccount(BaseModel):
    # The password, where there is one. An account made with Google confirms
    # by typing the word instead — there is nothing else it could type.
    password: Optional[str] = Field(default=None, max_length=200)
    confirm: Optional[str] = Field(default=None, max_length=32)


@router.delete("")
def delete_account(
    body: DeleteAccount,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rate_limit.enforce(request, "account-delete", max_calls=5, window_seconds=3600,
                       message="Too many attempts. Please wait a moment and try again.", user=user)
    if user.password_hash:
        if not body.password or not security.verify_password(body.password, user.password_hash):
            raise HTTPException(400, "Incorrect email or password.")
    elif (body.confirm or "").strip().upper() != "DELETE":
        raise HTTPException(400, 'Type DELETE to confirm.')

    uid = user.id

    # Order matters only where a row points at another row of ours: photos at
    # devices, members at classrooms. Everything else points at the user alone.
    device_ids = [d.id for d in db.query(PairedDevice.id).filter(PairedDevice.user_id == uid)]
    if device_ids:
        db.query(PhonePhoto).filter(PhonePhoto.device_id.in_(device_ids)).delete(synchronize_session=False)
    db.query(PhonePhoto).filter(PhonePhoto.user_id == uid).delete(synchronize_session=False)
    db.query(PairedDevice).filter(PairedDevice.user_id == uid).delete(synchronize_session=False)
    db.query(PairRequest).filter(PairRequest.user_id == uid).delete(synchronize_session=False)

    # A teacher's classes go with the teacher; their students simply stop being
    # in a class that no longer exists. A student's memberships go with them.
    class_ids = [c.id for c in db.query(Classroom.id).filter(Classroom.teacher_user_id == uid)]
    if class_ids:
        db.query(ClassroomMember).filter(ClassroomMember.classroom_id.in_(class_ids)).delete(synchronize_session=False)
        db.query(Classroom).filter(Classroom.id.in_(class_ids)).delete(synchronize_session=False)
    db.query(ClassroomMember).filter(ClassroomMember.student_user_id == uid).delete(synchronize_session=False)

    # Links in both directions: a parent who leaves stops seeing; a student who
    # leaves stops being seen. Nobody else's account changes otherwise.
    db.query(FamilyLink).filter((FamilyLink.parent_user_id == uid) | (FamilyLink.student_user_id == uid)).delete(synchronize_session=False)
    db.query(FamilyInvite).filter(FamilyInvite.student_user_id == uid).delete(synchronize_session=False)

    db.query(Task).filter(Task.user_id == uid).delete(synchronize_session=False)
    db.query(ScanHistory).filter(ScanHistory.user_id == uid).delete(synchronize_session=False)
    db.query(FocusSession).filter(FocusSession.user_id == uid).delete(synchronize_session=False)
    db.query(VerificationCode).filter(VerificationCode.user_id == uid).delete(synchronize_session=False)
    db.query(CodeAttempt).filter(CodeAttempt.user_id == uid).delete(synchronize_session=False)
    db.query(OAuthIdentity).filter(OAuthIdentity.user_id == uid).delete(synchronize_session=False)
    db.query(User).filter(User.id == uid).delete(synchronize_session=False)
    db.commit()
    return {"status": "deleted"}
