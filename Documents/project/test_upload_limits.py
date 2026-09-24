# -*- coding: utf-8 -*-
# test_upload_limits.py — what a student is told when a scan is too big.
#
# Two things were wrong at once. The message the server writes never reached
# them, because a Pydantic validator failure is a 422 whose `detail` is a list
# and both call sites only render `detail` when it is a string — so an oversized
# scan read as "check your internet" and the student retried the same photos
# forever. And the rejection echoed the whole rejected upload back: 6.4 MB up,
# 6.4 MB down, to be told no, on mobile data.
#
# Run:  python -m pytest test_upload_limits.py -q
import os
import tempfile

_tmp_db = os.path.join(tempfile.mkdtemp(), "limits.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import rate_limit  # noqa: E402
import server  # noqa: E402

client = TestClient(server.app)


def _ask(images):
    rate_limit._hits.clear()
    return client.post("/ask", json={"images": images, "question": "solve this", "lang": "bg"})


def test_one_oversized_photo_is_refused_in_words():
    res = _ask(["x" * (server.MAX_ASK_IMAGE_CHARS + 10)])
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert isinstance(detail, str), "the frontend only renders detail when it is a string"
    assert "твърде голяма" in detail, detail
    # and it tells them what to do about it
    assert "сканирай" in detail.lower() or "пак" in detail.lower()


def test_too_many_photos_together_are_refused_in_words():
    """Just over the aggregate cap, and still under the body limit — otherwise
    the 413 middleware answers first and this tests the wrong thing."""
    count = server.MAX_ASK_IMAGES
    each = (server.MAX_ASK_IMAGES_CHARS // count) + 5_000
    assert each * count > server.MAX_ASK_IMAGES_CHARS, "this payload is under the cap"
    assert each * count < server.MAX_BODY_BYTES, "this payload would trip the 413 instead"
    res = _ask(["x" * each] * count)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert isinstance(detail, str)
    assert "твърде големи" in detail, detail


def test_the_refusal_does_not_send_the_upload_back():
    """FastAPI's default handler puts the offending value in the response. A
    student on mobile data uploaded 6.4 MB and was sent all of it back."""
    payload = "x" * (server.MAX_ASK_IMAGE_CHARS + 10)
    res = _ask([payload])
    assert res.status_code == 422
    assert len(res.content) < 2000, f"the rejection is {len(res.content)} bytes"
    assert payload[:200] not in res.text, "the upload is being echoed back"


def test_an_ordinary_bad_request_still_says_something_useful():
    rate_limit._hits.clear()
    res = client.post("/ask", json={"question": ""})     # no question at all
    assert res.status_code == 422
    assert isinstance(res.json()["detail"], str)
    assert res.json()["detail"], "an empty message is no better than a list"


def test_the_aggregate_cap_can_actually_be_reached():
    """A cap above MAX_BODY_BYTES can never fire: the body-size middleware
    refuses the whole request with a 413 first, so the student is told the
    request was too large rather than which part of it was. A limit that cannot
    trigger is worse than none, because the next reader believes it guards
    something."""
    overhead = 40_000        # the JSON around the images, generously
    assert server.MAX_ASK_IMAGES_CHARS + overhead < server.MAX_BODY_BYTES, (
        f"the aggregate cap ({server.MAX_ASK_IMAGES_CHARS:,} chars) sits above the body "
        f"limit ({server.MAX_BODY_BYTES:,} bytes) and can never be the thing that refuses"
    )
    assert server.MAX_ASK_IMAGE_CHARS < server.MAX_ASK_IMAGES_CHARS


def test_the_caps_match_what_the_scanner_actually_sends():
    """scanner.js encodes at 0.92 now. Eight dense pages come to roughly 6.6 MB
    of base64, which the old 6 MB aggregate cap would have refused."""
    import re
    here = os.path.dirname(__file__)
    with open(os.path.join(here, "frontend", "scanner.js"), encoding="utf-8") as f:
        js = f.read()
    quality = float(re.search(r"const UPLOAD_QUALITY = ([0-9.]+);", js).group(1))
    assert quality >= 0.9
    # a dense page at this quality, measured: ~600 KB -> ~850k base64 chars
    dense_page = 850_000
    assert server.MAX_ASK_IMAGE_CHARS > dense_page, "one dense page would be refused"
    assert server.MAX_ASK_IMAGES_CHARS >= dense_page * 8, "eight dense pages would be refused"


def test_too_many_pages_is_said_in_the_app_s_voice():
    """Pydantic's own message is English prose about lists — "List should have
    at most 8 items after validation, not 9" — which a Bulgarian twelve-year-old
    would now be shown verbatim, since the detail is rendered."""
    res = _ask(["x" * 100] * (server.MAX_ASK_IMAGES + 1))
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "List should have" not in detail, detail
    assert "страници" in detail, detail
