# rate_limit.py — лек лимит по IP в паметта на процеса, за да не може един клиент
# (или бот) да предизвика неограничени разходи за Anthropic API през /ask и /plan.
# Забележка: пази състоянието в паметта на един процес — коректно за единичен
# Render инстанс; при няколко инстанса (хоризонтално мащабиране) лимитът е per-instance.
import time
from collections import defaultdict
from threading import Lock

from fastapi import HTTPException, Request

_lock = Lock()
_hits: dict[str, list] = defaultdict(list)


def _client_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce(request: Request, bucket: str, max_calls: int, window_seconds: int, message: str) -> None:
    key = f"{bucket}:{_client_key(request)}"
    now = time.time()
    with _lock:
        hits = _hits[key]
        cutoff = now - window_seconds
        while hits and hits[0] < cutoff:
            hits.pop(0)
        if len(hits) >= max_calls:
            raise HTTPException(429, message)
        hits.append(now)
