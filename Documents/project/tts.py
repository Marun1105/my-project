# tts.py — online voices: the answer read aloud by Azure's neural voices.
#
# The desktop app can only use the voices installed in Windows: three English
# ones on a stock PC, and no Bulgarian at all. These come from Azure Speech
# instead, the same on every computer and phone, with natural Bulgarian.
#
# Off until the server has AZURE_SPEECH_KEY and AZURE_SPEECH_REGION; then the
# voice picker shows them and speak.js uses them. Without them, or past the
# daily cap, or offline, the app falls back to the computer's own voices.
#
# Cost control: signed-in students only, a limit per person, a daily character
# cap for everyone (Azure's free tier is 500,000 characters a month), and a
# small cache so the same sentence is never paid for twice.
import hashlib
import os
import threading
from collections import OrderedDict
from datetime import date
from typing import Literal
from xml.sax.saxutils import escape

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

import rate_limit
from auth import get_current_user
from models import User

router = APIRouter(prefix="/tts", tags=["tts"])

# Chosen by ear, not the whole catalogue: a list of four hundred names helps
# nobody choose. The id is Azure's; it is also the allowlist — nothing else is
# ever put into the request to Azure.
VOICES = {
    "bg": [
        {"id": "bg-BG-KalinaNeural", "name": "Kalina", "gender": "f", "accent": "BG"},
        {"id": "bg-BG-BorislavNeural", "name": "Borislav", "gender": "m", "accent": "BG"},
    ],
    "en": [
        {"id": "en-US-AvaMultilingualNeural", "name": "Ava", "gender": "f", "accent": "US"},
        {"id": "en-US-AndrewMultilingualNeural", "name": "Andrew", "gender": "m", "accent": "US"},
        {"id": "en-US-EmmaMultilingualNeural", "name": "Emma", "gender": "f", "accent": "US"},
        {"id": "en-US-BrianMultilingualNeural", "name": "Brian", "gender": "m", "accent": "US"},
        {"id": "en-US-JennyNeural", "name": "Jenny", "gender": "f", "accent": "US"},
        {"id": "en-US-GuyNeural", "name": "Guy", "gender": "m", "accent": "US"},
        {"id": "en-GB-SoniaNeural", "name": "Sonia", "gender": "f", "accent": "UK"},
        {"id": "en-GB-RyanNeural", "name": "Ryan", "gender": "m", "accent": "UK"},
        {"id": "en-GB-LibbyNeural", "name": "Libby", "gender": "f", "accent": "UK"},
        {"id": "en-AU-NatashaNeural", "name": "Natasha", "gender": "f", "accent": "AU"},
        {"id": "en-AU-WilliamNeural", "name": "William", "gender": "m", "accent": "AU"},
        {"id": "en-IE-EmilyNeural", "name": "Emily", "gender": "f", "accent": "IE"},
    ],
}
LOCALE = {"bg": "bg-BG", "en": "en-US"}
_BY_ID = {v["id"]: lang for lang, voices in VOICES.items() for v in voices}

MAX_CHARS = 2500                 # one request; speak.js sends long answers in parts
CACHE_ITEMS = 80


def _key() -> str:
    return os.environ.get("AZURE_SPEECH_KEY", "").strip()


def _region() -> str:
    return os.environ.get("AZURE_SPEECH_REGION", "").strip()


def enabled() -> bool:
    return bool(_key() and _region())


def _daily_cap() -> int:
    # 500,000 a month free, so about 16,000 a day keeps the month free
    try:
        return int(os.environ.get("TTS_DAILY_CHARS", "16000"))
    except ValueError:
        return 16000


# Per process, which is good enough: the cap guards a bill, not a secret, and a
# second worker can only overshoot it by its own share of one day.
_lock = threading.Lock()
_used = {"day": None, "chars": 0}
_cache: "OrderedDict[str, bytes]" = OrderedDict()


def _spend(chars: int) -> bool:
    with _lock:
        today = date.today()
        if _used["day"] != today:
            _used["day"], _used["chars"] = today, 0
        if _used["chars"] + chars > _daily_cap():
            return False
        _used["chars"] += chars
        return True


def _cached(key: str):
    with _lock:
        audio = _cache.get(key)
        if audio is not None:
            _cache.move_to_end(key)
        return audio


def _remember(key: str, audio: bytes) -> None:
    with _lock:
        _cache[key] = audio
        _cache.move_to_end(key)
        while len(_cache) > CACHE_ITEMS:
            _cache.popitem(last=False)


def _synthesize(voice_id: str, text: str, rate: str) -> bytes:
    """The one call to Azure. Kept apart so the tests can stand in for it."""
    lang = LOCALE[_BY_ID[voice_id]]
    ssml = (f"<speak version='1.0' xml:lang='{lang}'><voice name='{voice_id}'>"
            f"<prosody rate='{rate}'>{escape(text)}</prosody></voice></speak>")
    res = httpx.post(
        f"https://{_region()}.tts.speech.microsoft.com/cognitiveservices/v1",
        content=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": _key(),
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "climby",
        },
        timeout=25,
    )
    if res.status_code != 200 or not res.content:
        raise RuntimeError(f"azure tts {res.status_code}")
    return res.content


@router.get("/voices")
def voices(lang: Literal["bg", "en"] = "en"):
    return {"enabled": enabled(), "voices": VOICES[lang] if enabled() else []}


class SpeakIn(BaseModel):
    voice: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    # a little slower for the youngest, as speak.js asks; nothing else is accepted
    rate: Literal["slow", "normal"] = "normal"


@router.post("")
def speak(body: SpeakIn, request: Request, user: User = Depends(get_current_user)):
    if not enabled():
        raise HTTPException(503, "Online voices are not switched on.")
    if body.voice not in _BY_ID:
        raise HTTPException(400, "Unknown voice.")
    rate_limit.enforce(request, "tts", max_calls=240, window_seconds=3600,
                       message="Too much reading aloud for now. Please wait a little.", user=user)
    text = " ".join(body.text.split())
    if not text:
        raise HTTPException(400, "Nothing to read.")
    rate = "-12%" if body.rate == "slow" else "0%"
    key = hashlib.sha256(f"{body.voice}|{rate}|{text}".encode("utf-8")).hexdigest()
    audio = _cached(key)
    if audio is None:
        if not _spend(len(text)):
            # the app falls back to the computer's voice on this answer
            raise HTTPException(429, "The online voices are resting until tomorrow.")
        try:
            audio = _synthesize(body.voice, text, rate)
        except Exception as err:  # noqa: BLE001 — any failure means: use the computer's voice
            print(f"[tts] {err!r}", flush=True)
            raise HTTPException(502, "The online voice is not answering.")
        _remember(key, audio)
    return Response(content=audio, media_type="audio/mpeg",
                    headers={"Cache-Control": "private, max-age=86400"})
