# scans.py — история от въпросите към учителя (снимка + въпрос -> отговор).
# Пазим само текста на въпроса и отговора — самите снимки никога не се качват
# в базата, само се обработват еднократно през /ask.
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from db import get_db
from models import ScanHistory, User
from schemas import ScanHistoryOut

router = APIRouter(prefix="/scans", tags=["scans"])


@router.get("", response_model=List[ScanHistoryOut])
def list_scans(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.query(ScanHistory)
        .filter(ScanHistory.user_id == user.id)
        .order_by(ScanHistory.created_at.desc())
        .limit(50)
        .all()
    )


@router.delete("/{scan_id}")
def delete_scan(scan_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    scan = db.query(ScanHistory).filter(ScanHistory.id == scan_id, ScanHistory.user_id == user.id).first()
    if not scan:
        raise HTTPException(404, "Записът не е намерен.")
    db.delete(scan)
    db.commit()
    return {"status": "ok"}
