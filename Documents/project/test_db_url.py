# test_db_url.py — the database address Render is given, as Render gives it.
#
# Neon's dashboard hands out "postgresql+psycopg://…" (the psycopg 3 driver).
# requirements.txt installs psycopg2. With that address the server died at
# import — "ModuleNotFoundError: No module named 'psycopg'" — and Render kept
# serving the last build that had ever booted, for weeks, with /healthz green.
# Every test here runs on SQLite, so nothing caught it. This imports db.py in a
# fresh interpreter with the production-shaped address and builds the engine,
# which is the step that raised.
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(__file__)

PROBE = (
    "import db; "
    "print(db.DATABASE_URL.split('://')[0]); "
    "print(db.engine.dialect.driver)"
)


def _import_db_with(url):
    env = {**os.environ, "DATABASE_URL": url}
    return subprocess.run([sys.executable, "-c", PROBE], cwd=HERE, env=env,
                          capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize("scheme", ["postgresql+psycopg", "postgresql+psycopg3",
                                    "postgres+psycopg", "POSTGRESQL+PSYCOPG",
                                    "postgres", "postgresql", "postgresql+psycopg2"])
def test_every_postgres_address_boots_on_the_installed_driver(scheme):
    run = _import_db_with(f"{scheme}://user:pw@ep-example.eu-central-1.aws.neon.tech/climby")
    assert run.returncode == 0, run.stderr[-800:]
    prefix, driver = run.stdout.split()
    assert driver == "psycopg2"
    assert prefix in ("postgresql", "postgresql+psycopg2")
