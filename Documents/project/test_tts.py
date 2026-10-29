# test_tts.py — online voices: off without a key, on with one, never past the cap.
import os
import tempfile

_tmp_db = os.path.join(tempfile.mkdtemp(), "tts.db")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp_db}")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("TRUSTED_PROXY_HOPS", "0")

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402
import tts  # noqa: E402
from conftest import phone_for_test_account  # noqa: E402
from db import SessionLocal  # noqa: E402
from models import User  # noqa: E402

client = TestClient(server.app)


def _login(email):
    rate_limit._hits.clear()
    client.post("/auth/register", json={"display_name": "T", "email": email,
                                        "phone": phone_for_test_account(email), "password": "testpass123"})
    db = SessionLocal()
    u = db.query(User).filter(User.email == email).first()
    u.is_email_verified = True
    db.commit(); db.close()
    return {"Authorization": "Bearer " + client.post("/auth/login", json={"email": email, "password": "testpass123"}).json()["token"]}


def _on(monkeypatch, calls):
    monkeypatch.setenv("AZURE_SPEECH_KEY", "k")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westeurope")

    def fake(voice, text, rate):
        calls.append((voice, text, rate))
        return b"ID3fake-mp3"
    monkeypatch.setattr(tts, "_synthesize", fake)
    tts._cache.clear()
    tts._used.update(day=None, chars=0, by_user={})


def test_off_without_a_key(monkeypatch):
    monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
    assert client.get("/tts/voices?lang=bg").json() == {"enabled": False, "voices": []}
    h = _login("tts-off@example.com")
    assert client.post("/tts", json={"voice": "bg-BG-KalinaNeural", "text": "Здравей"}, headers=h).status_code == 503


def test_on_with_a_key_and_bulgarian_is_there(monkeypatch):
    calls = []
    _on(monkeypatch, calls)
    names = [v["name"] for v in client.get("/tts/voices?lang=bg").json()["voices"]]
    assert names == ["Kalina", "Borislav"]
    h = _login("tts-on@example.com")
    res = client.post("/tts", json={"voice": "bg-BG-KalinaNeural", "text": "  Две   и две  "}, headers=h)
    assert res.status_code == 200 and res.headers["content-type"] == "audio/mpeg" and res.content == b"ID3fake-mp3"
    assert calls == [("bg-BG-KalinaNeural", "Две и две", "0%")]


def test_only_listed_voices_and_signed_in(monkeypatch):
    _on(monkeypatch, [])
    assert client.post("/tts", json={"voice": "en-US-AvaMultilingualNeural", "text": "Hi"}).status_code == 401
    h = _login("tts-allow@example.com")
    bad = "en-US-Ava'/><break time='9s'/><voice name='x"
    assert client.post("/tts", json={"voice": bad, "text": "Hi"}, headers=h).status_code == 400


def test_the_same_sentence_is_paid_for_once(monkeypatch):
    calls = []
    _on(monkeypatch, calls)
    h = _login("tts-cache@example.com")
    for _ in range(3):
        client.post("/tts", json={"voice": "en-GB-SoniaNeural", "text": "Same words."}, headers=h)
    assert len(calls) == 1


def test_the_daily_cap_falls_back(monkeypatch):
    _on(monkeypatch, [])
    monkeypatch.setenv("TTS_DAILY_CHARS", "10")
    h = _login("tts-cap@example.com")
    assert client.post("/tts", json={"voice": "en-GB-RyanNeural", "text": "short"}, headers=h).status_code == 200
    assert client.post("/tts", json={"voice": "en-GB-RyanNeural", "text": "a bit longer"}, headers=h).status_code == 429


def test_one_student_cannot_use_up_everyone_s_day(monkeypatch):
    _on(monkeypatch, [])
    monkeypatch.setenv("TTS_USER_DAILY_CHARS", "10")
    greedy, other = _login("tts-greedy@example.com"), _login("tts-other@example.com")
    assert client.post("/tts", json={"voice": "en-GB-RyanNeural", "text": "short"}, headers=greedy).status_code == 200
    assert client.post("/tts", json={"voice": "en-GB-RyanNeural", "text": "a bit longer"}, headers=greedy).status_code == 429
    assert client.post("/tts", json={"voice": "en-GB-RyanNeural", "text": "mine now"}, headers=other).status_code == 200


def test_a_failed_call_costs_nothing(monkeypatch):
    _on(monkeypatch, [])
    monkeypatch.setenv("TTS_USER_DAILY_CHARS", "10")

    def broken(voice, text, rate):
        raise RuntimeError("azure tts 500")
    monkeypatch.setattr(tts, "_synthesize", broken)
    h = _login("tts-refund@example.com")
    for _ in range(3):
        assert client.post("/tts", json={"voice": "en-GB-RyanNeural", "text": "abcdefgh"}, headers=h).status_code == 502
    assert tts._used["chars"] == 0

def test_text_is_escaped_for_the_request(monkeypatch):
    seen = {}
    monkeypatch.setenv("AZURE_SPEECH_KEY", "k")
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westeurope")

    class _Res:
        status_code = 200
        content = b"mp3"

    def fake_post(url, content, headers, timeout):
        seen["ssml"] = content.decode("utf-8")
        return _Res()
    monkeypatch.setattr(tts.httpx, "post", fake_post)
    assert tts._synthesize("en-US-JennyNeural", "x < y & </voice>", "0%") == b"mp3"
    assert "x &lt; y &amp; &lt;/voice&gt;" in seen["ssml"]
