# test_papers.py — past exam papers: the catalogue, and the mirror in front of the Ministry.
#
# Run:  python -m pytest test_papers.py -q
import os
import tempfile

import pytest

os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ["TRUSTED_PROXY_HOPS"] = "0"
os.environ["PAPERS_CACHE_DIR"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402

import papers  # noqa: E402
import rate_limit  # noqa: E402
import server  # noqa: E402

client = TestClient(server.app)


@pytest.fixture(autouse=True)
def _clean():
    rate_limit._hits.clear()
    yield


def test_the_catalogue_is_sound():
    """Every row is a real Ministry paper with a unique id and a sane year.

    This is the test that guards a typo in papers.json from becoming a broken
    year in a seventh-grader's exam prep.
    """
    cat = papers.load_catalogue()
    ids = [p["id"] for p in cat["papers"]]
    assert len(ids) == len(set(ids)), "duplicate id"
    for p in cat["papers"]:
        assert p["exam"] in cat["exams"], p["id"]
        assert p["subject"] in cat["subjects"], p["id"]
        assert 2010 <= p["year"] <= 2030, p["id"]
        assert p["url"].startswith("https://www.mon.bg/"), "papers come from the Ministry only"
        assert papers._SAFE_ID.match(p["id"]), p["id"]
    for key in ("exams", "subjects"):
        for entry in cat[key].values():
            assert set(entry["label"]) == {"bg", "en"}, "every label in both languages"


def test_the_browser_never_sees_the_ministry_urls():
    body = client.get("/papers").json()
    assert body["papers"], "an empty catalogue"
    assert all("url" not in p for p in body["papers"])
    assert "nvo7" in body["exams"]


def test_only_catalogue_ids_can_be_fetched():
    """A mirror of a fixed list, never a proxy."""
    assert client.get("/papers/not-a-real-id.pdf").status_code == 404
    assert client.get("/papers/..%2F..%2Fserver.pdf").status_code == 404


def test_a_paper_is_fetched_once_and_then_served_from_disk(monkeypatch):
    calls = []

    class FakeResponse:
        status_code = 200
        headers = {"content-type": "application/pdf"}
        def iter_bytes(self): yield b"%PDF-1.4 fake"
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_stream(method, url, **kw):
        calls.append(url)
        return FakeResponse()

    monkeypatch.setattr(papers.httpx, "stream", fake_stream)
    first = client.get("/papers/nvo7-math-2025.pdf")
    second = client.get("/papers/nvo7-math-2025.pdf")
    assert first.status_code == second.status_code == 200
    assert first.headers["content-type"] == "application/pdf"
    assert "immutable" in first.headers["cache-control"]
    assert len(calls) == 1, "the Ministry was asked more than once"
    assert calls[0].startswith("https://www.mon.bg/")


def test_a_paper_that_is_not_a_pdf_is_refused(monkeypatch):
    """If the Ministry answers with an HTML error page, we must not cache it as a paper."""
    class NotPdf:
        status_code = 200
        headers = {"content-type": "text/html"}
        def iter_bytes(self): yield b"<html>"
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(papers.httpx, "stream", lambda *a, **k: NotPdf())
    res = client.get("/papers/nvo7-math-2016.pdf")
    assert res.status_code == 502
    assert not (papers.CACHE_DIR / "nvo7-math-2016.pdf").exists(), "a non-PDF was cached"
