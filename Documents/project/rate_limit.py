# rate_limit.py — лек лимит по IP в паметта на процеса, за да не може един клиент
# (или бот) да предизвика неограничени разходи за Anthropic API през /ask и /plan.
# Забележка: пази състоянието в паметта на един процес — коректно за единичен
# Render инстанс; при няколко инстанса (хоризонтално мащабиране) лимитът е per-instance.
import os
import time
from collections import defaultdict
from threading import Lock

from fastapi import HTTPException, Request

_lock = Lock()
_hits: dict[str, list] = defaultdict(list)
# Прозорецът на всяка кофа се помни отделно. Ключовете на всички кофи стоят в един
# речник, а изтичат по различно време: "register" е с час, "login" — с петнайсет
# минути. Ако чистенето реши кой ключ е стар по прозореца на кофата, която случайно
# го е задействала, дългите лимити мълчаливо се съкращават до най-късия в приложението.
_bucket_windows: dict[str, int] = {}

# Колко обратни проксита стоят пред приложението (Render = 1). Всяко прокси ДОБАВЯ
# истинския адрес най-отдясно в X-Forwarded-For, затова броим отдясно наляво.
# Лявата част на заглавката е изцяло под контрола на клиента — ако я четем оттам,
# всеки може да сложи произволен адрес на всяка заявка и лимитът става безсмислен.
# 0 = не се доверяваме на заглавката изобщо (локално, без прокси).
def _int_env(name: str, default: int) -> int:
    # Празна стойност в таблото на Render не е същото като липсваща променлива:
    # int("") хвърля ValueError още при import и сървърът изобщо не тръгва.
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default  # непопълнена е нормално — мълчим
    try:
        return int(raw.strip())
    except ValueError:
        print(f"{name}={raw!r} не е число — ползвам {default}.")
        return default


TRUSTED_PROXY_HOPS = _int_env("TRUSTED_PROXY_HOPS", 1)


def _client_key(request: Request) -> str:
    direct = request.client.host if request.client else "unknown"
    if TRUSTED_PROXY_HOPS <= 0:
        return direct

    fwd = request.headers.get("x-forwarded-for")
    if not fwd:
        return direct

    parts = [p.strip() for p in fwd.split(",") if p.strip()]
    if not parts:
        return direct
    # Вземаме адреса, добавен от най-близкото доверено прокси; ако заглавката е
    # по-къса от очакваното, падаме до най-левия наличен, но никога по-наляво.
    index = max(0, len(parts) - TRUSTED_PROXY_HOPS)
    return parts[index]


# Клиентите се сменят постоянно, а ключовете им иначе стоят завинаги в паметта —
# чистим изтеклите наведнъж, вместо при всяка заявка.
_CLEANUP_EVERY = 500
_calls_since_cleanup = 0


def _evict_stale(now: float) -> None:
    # Ключът е "кофа:адрес", а адресът може сам да съдържа двоеточие (IPv6),
    # затова режем само по първото.
    stale = []
    for key, hits in _hits.items():
        window = _bucket_windows.get(key.split(":", 1)[0])
        if window is None:
            continue  # непозната кофа — по-добре да заеме малко памет, отколкото да падне рано
        if not hits or hits[-1] < now - window:
            stale.append(key)
    for key in stale:
        del _hits[key]


def enforce(request: Request, bucket: str, max_calls: int, window_seconds: int, message: str) -> None:
    global _calls_since_cleanup
    key = f"{bucket}:{_client_key(request)}"
    now = time.time()
    with _lock:
        # Записваме прозореца, преди да е създаден ключ на тази кофа — така чистенето
        # никога не среща ключ, за който не знае по колко време изтича.
        _bucket_windows[bucket] = window_seconds

        # Броят се и отхвърлените заявки: това е ритъм на чистенето, а не квота.
        # Безопасно е само защото всяка кофа вече се чисти със собствения си прозорец.
        _calls_since_cleanup += 1
        if _calls_since_cleanup >= _CLEANUP_EVERY:
            _calls_since_cleanup = 0
            _evict_stale(now)

        hits = _hits[key]
        cutoff = now - window_seconds
        while hits and hits[0] < cutoff:
            hits.pop(0)
        if len(hits) >= max_calls:
            raise HTTPException(429, message)
        hits.append(now)
