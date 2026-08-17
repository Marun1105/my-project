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

# Колко обратни проксита стоят пред приложението (Render = 1). Всяко прокси ДОБАВЯ
# истинския адрес най-отдясно в X-Forwarded-For, затова броим отдясно наляво.
# Лявата част на заглавката е изцяло под контрола на клиента — ако я четем оттам,
# всеки може да сложи произволен адрес на всяка заявка и лимитът става безсмислен.
# 0 = не се доверяваме на заглавката изобщо (локално, без прокси).
TRUSTED_PROXY_HOPS = int(os.environ.get("TRUSTED_PROXY_HOPS", "1"))


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


def _evict_stale(now: float, window_seconds: int) -> None:
    for key in [k for k, hits in _hits.items() if not hits or hits[-1] < now - window_seconds]:
        del _hits[key]


def enforce(request: Request, bucket: str, max_calls: int, window_seconds: int, message: str) -> None:
    global _calls_since_cleanup
    key = f"{bucket}:{_client_key(request)}"
    now = time.time()
    with _lock:
        _calls_since_cleanup += 1
        if _calls_since_cleanup >= _CLEANUP_EVERY:
            _calls_since_cleanup = 0
            _evict_stale(now, window_seconds)

        hits = _hits[key]
        cutoff = now - window_seconds
        while hits and hits[0] < cutoff:
            hits.pop(0)
        if len(hits) >= max_calls:
            raise HTTPException(429, message)
        hits.append(now)
