# test_oauth.py — signing in with a Google account.
#
# Run:  python -m pytest test_oauth.py -q
import os
import tempfile

import pytest

_tmp_db = os.path.join(tempfile.mkdtemp(), "oauth.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import oauth  # noqa: E402


def test_a_token_we_cannot_verify_is_rejected_not_trusted():
    """An unverifiable token must raise, never fall through as an empty identity."""
    with pytest.raises(oauth.IdentityRejected):
        oauth.verify_google_id_token("not-a-jwt-at-all")
