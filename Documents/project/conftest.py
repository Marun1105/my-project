# conftest.py — no test ever reaches the real Anthropic API.
#
# server.py calls load_dotenv() at import, and the project's .env holds a real
# key. So a test that forgot to stub the client did not fail: it made a real,
# billed call, slowly, and passed or failed on whatever the model happened to
# say. With every new call site that got more likely, not less.
#
# Two guards. The key is replaced before anything imports the SDK —
# load_dotenv does not override a variable that is already set. And every
# create() on the SDK raises unless the test stubbed it; a test that patches
# `server.client.messages.create` (an instance attribute) still wins over this
# class-level default, so existing stubs keep working.
import os

os.environ["ANTHROPIC_API_KEY"] = "sk-test-never-real"

import pytest  # noqa: E402


class UnstubbedAnthropicCall(RuntimeError):
    pass


def _refuse(*_args, **_kwargs):
    raise UnstubbedAnthropicCall(
        "a test reached the Anthropic API without stubbing it — "
        "patch the create() it calls"
    )


@pytest.fixture(autouse=True)
def _no_real_model_calls(monkeypatch):
    import anthropic.resources.messages.messages as plain
    import anthropic.resources.beta.messages.messages as beta
    monkeypatch.setattr(plain.Messages, "create", _refuse)
    monkeypatch.setattr(beta.Messages, "create", _refuse)
    yield
