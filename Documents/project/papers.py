# papers.py — past exam papers, fetched from the Ministry once and served from here.
#
# The Ministry publishes every НВО and матура paper as a PDF, for preparation.
# A browser cannot fetch them directly — mon.bg sends no CORS headers — so this
# router does: once per paper, cached on disk, then served same-origin with
# long cache headers. The catalogue is papers.json; adding a paper is a row
# there. Only catalogue ids can be requested, so this is a mirror of a fixed
# list, never a proxy for arbitrary addresses.
import json
import os
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import FileResponse

import rate_limit

router = APIRouter(prefix="/papers", tags=["papers"])

_HERE = Path(__file__).parent
CATALOGUE_PATH = _HERE / "papers.json"
# Render's disk does not survive a restart; the cache is simply rebuilt on
# first request afterwards. Local runs keep it between starts.
CACHE_DIR = Path(os.environ.get("PAPERS_CACHE_DIR", _HERE / "papers_cache"))
MAX_BYTES = 12 * 1024 * 1024   # the largest paper seen is 3.2 MB; this is generous
_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,60}$")


def load_catalogue() -> dict:
    with open(CATALOGUE_PATH, encoding="utf-8") as f:
        data = json.load(f)
    data.pop("_", None)
    return data


_catalogue = load_catalogue()
_by_id = {p["id"]: p for p in _catalogue["papers"]}


def _public_view() -> dict:
    """The catalogue without the Ministry URLs. The browser never needs them."""
    return {
        "exams": _catalogue["exams"],
        "subjects": _catalogue["subjects"],
        "papers": [{k: v for k, v in p.items() if k != "url"} for p in _catalogue["papers"]],
    }


@router.get("")
def catalogue():
    return _public_view()


def _fetch_to_cache(paper: dict, target: Path) -> None:
    """One download, streamed to disk, refused if it grows past the cap."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".part")
    written = 0
    try:
        with httpx.stream("GET", paper["url"], timeout=60, follow_redirects=True) as r:
            if r.status_code != 200 or "pdf" not in (r.headers.get("content-type") or "").lower():
                raise HTTPException(502, "The Ministry's site did not return this paper.")
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes():
                    written += len(chunk)
                    if written > MAX_BYTES:
                        raise HTTPException(502, "This paper is larger than expected.")
                    f.write(chunk)
        os.replace(tmp, target)
    except httpx.HTTPError as err:
        print(f"[papers] could not fetch {paper['id']}: {err!r}", flush=True)
        raise HTTPException(502, "Could not reach the Ministry's site. Please try again.")
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


@router.get("/{paper_id}.pdf")
def paper_pdf(paper_id: str, request: Request):
    # Guests too: preparing for an exam should not need an account. Keyed by IP,
    # generous enough for a classroom, and every hit after the first is a disk read.
    rate_limit.enforce(request, "papers", max_calls=120, window_seconds=3600,
                       message="Too many requests. Please wait a moment and try again.")
    if not _SAFE_ID.match(paper_id) or paper_id not in _by_id:
        raise HTTPException(404, "No such paper.")
    target = CACHE_DIR / f"{paper_id}.pdf"
    if not target.exists():
        _fetch_to_cache(_by_id[paper_id], target)
    return FileResponse(
        target,
        media_type="application/pdf",
        headers={"Cache-Control": "public, max-age=2592000, immutable"},
    )
