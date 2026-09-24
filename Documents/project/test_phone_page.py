# -*- coding: utf-8 -*-
# test_phone_page.py — the page the phone shoots from.
#
# It ships with the BACKEND, not the installer: server.py reads it into
# _PHONE_PAGE once at startup, so a change here needs a deploy and a restart.
#
# Run:  python -m pytest test_phone_page.py -q
import os
import re

HERE = os.path.dirname(__file__)


def _phone():
    with open(os.path.join(HERE, "phone_page.html"), encoding="utf-8") as f:
        return f.read()


def _scanner():
    with open(os.path.join(HERE, "frontend", "scanner.js"), encoding="utf-8") as f:
        return f.read()


def test_the_phone_asks_the_camera_for_a_real_photo():
    """The viewfinder gives a frame off the video stream — no autofocus lock, no
    exposure, none of the processing a phone puts into an actual photograph. A
    page of handwriting came out soft unless the phone was held still long
    enough for continuous focus to settle on its own, which is what a student
    experienced as "hold it there for ten seconds"."""
    html = _phone()
    assert "ImageCapture" in html and "takePhoto()" in html
    # and it must not be the only path: Safari has no ImageCapture
    assert "grabBestFrame" in html, "no fallback for a browser without ImageCapture"


def test_the_fallback_picks_the_sharpest_of_several_frames():
    """One frame taken at an arbitrary instant catches the autofocus
    mid-hunt. Several, then the sharpest, is a comparison rather than a
    threshold — and a threshold is the thing that could not be calibrated
    without a phone in hand."""
    html = _phone()
    burst = html[html.index("function grabBestFrame()"):]
    burst = burst[:burst.index("\n  }")]
    assert "sharpness(canvas)" in burst
    assert "score > bestScore" in burst
    assert "setTimeout(next" in burst, "the frames must be spread over time, not taken at once"


def test_sharpness_never_throws_on_a_tainted_canvas():
    """getImageData on a canvas drawn from another origin raises. A photo that
    cannot be measured should still be sendable."""
    html = _phone()
    fn = html[html.index("function sharpness(canvas)"):]
    fn = fn[:fn.index("\n  }")]
    assert "try {" in fn and "catch (e)" in fn
    assert "return 0;" in fn


def test_the_phone_and_the_computer_agree_on_quality():
    """Two files, one decision. They drifted once already: the computer's
    scanner went to 0.92 because pencil is a thin low-contrast edge and JPEG
    spends its error budget there first, and the phone stayed at 0.82 purely
    because it is a different file — so the better camera sent the worse
    picture."""
    phone = float(re.search(r"var QUALITY = ([0-9.]+);", _phone()).group(1))
    desktop = float(re.search(r"const UPLOAD_QUALITY = ([0-9.]+);", _scanner()).group(1))
    assert phone == desktop, (
        f"the phone encodes at {phone} and the computer at {desktop}; "
        f"the phone has the better camera and should not send the worse picture"
    )


def test_the_phone_and_the_computer_agree_on_size():
    phone = int(re.search(r"var MAX_DIM = (\d+);", _phone()).group(1))
    desktop = int(re.search(r"const MAX_UPLOAD_DIM = (\d+);", _scanner()).group(1))
    assert phone == desktop == 1568, "1568 is what the model resizes to anyway"


def test_the_shutter_says_something_while_the_camera_works():
    """Taking a real photo is not instant. Without a word on screen the wait
    reads as a button that did nothing, and the student presses again."""
    html = _phone()
    handler = html[html.index("$('shutter').addEventListener"):]
    handler = handler[:handler.index("\n  });")]
    assert "setStatus(t('focusing')" in handler
    assert "if (sending) return;" in handler, "a second press must not start a second photo"


def test_the_new_string_exists_in_both_languages():
    html = _phone()
    assert html.count("focusing:") == 2, "one of the two languages is missing it"


def test_the_upload_still_fits_what_the_server_accepts():
    """The phone encodes at 0.92 now. One page must stay under the per-image
    cap the server enforces."""
    import importlib
    os.environ.setdefault("DATABASE_URL", "sqlite:///" + os.path.join(HERE, "_phone_test.db"))
    os.environ.setdefault("JWT_SECRET", "test-secret")
    server = importlib.import_module("server")
    # measured at 1568px, quality 0.92, on a real photograph of a page: ~187 KB
    # of base64; a dense page roughly triples that
    assert server.MAX_ASK_IMAGE_CHARS > 850_000
