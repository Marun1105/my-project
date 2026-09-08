# test_rate_limit.py — по кого се брои лимитът.
#
# Пускане:  python -m pytest test_rate_limit.py -q
import os
import types

import pytest
from fastapi import HTTPException

os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ["TRUSTED_PROXY_HOPS"] = "0"

import rate_limit  # noqa: E402


def _request(ip):
    """Най-малкото, което enforce() пипа от заявката."""
    return types.SimpleNamespace(
        client=types.SimpleNamespace(host=ip),
        headers={},
    )


def _user(uid):
    return types.SimpleNamespace(id=uid)


@pytest.fixture(autouse=True)
def _clean():
    rate_limit._hits.clear()
    yield
    rate_limit._hits.clear()


def _ask(request, user=None, times=1):
    for _ in range(times):
        rate_limit.enforce(request, "ask", max_calls=3, window_seconds=3600,
                           message="стига", user=user)


# --------------------------------------------------------------------------
# класната стая
# --------------------------------------------------------------------------

def test_one_classroom_does_not_share_one_quota():
    """Тридесет деца зад един адрес не са един клиент.

    Училището излиза в интернет през един публичен адрес. Докато лимитът се
    броеше по адрес, първите три въпроса в кабинета изяждаха часа на всички —
    и детето, което не е попитало нищо, чуваше "твърде много въпроси". Точно
    там, където приложението е предназначено да работи.
    """
    school = _request("77.77.77.77")
    _ask(school, user=_user("dete-1"), times=3)  # първото дете изчерпва своето

    with pytest.raises(HTTPException):
        _ask(school, user=_user("dete-1"))  # то самото е спряно — така трябва

    _ask(school, user=_user("dete-2"), times=3)  # съседът по чин е недокоснат
    _ask(school, user=_user("dete-30"), times=3)


def test_the_same_account_cannot_start_over_on_another_network():
    """Смяната на мрежата не бива да нулира квотата — инак лимитът е украса."""
    _ask(_request("10.0.0.1"), user=_user("същият"), times=3)
    with pytest.raises(HTTPException):
        _ask(_request("192.168.1.1"), user=_user("същият"))


def test_guests_still_share_the_address():
    """Без акаунт друго няма. Гостите зад един адрес се броят заедно — съзнателно."""
    school = _request("77.77.77.77")
    _ask(school, times=3)
    with pytest.raises(HTTPException):
        _ask(school)


# --------------------------------------------------------------------------
# преди вход
# --------------------------------------------------------------------------

def test_the_limits_before_login_stay_on_the_address():
    """Регистрация и вход НЕ бива да се броят по акаунт.

    Ключ по акаунт там не значи нищо: нападателят прави нов акаунт (или подава
    нов имейл) и защитата изчезва при всеки опит. Единственото, което остава
    общо за него, е адресът.
    """
    attacker = _request("6.6.6.6")
    for _ in range(5):
        rate_limit.enforce(attacker, "register", max_calls=5, window_seconds=3600,
                           message="стига")
    with pytest.raises(HTTPException):
        rate_limit.enforce(attacker, "register", max_calls=5, window_seconds=3600,
                           message="стига")


def test_an_account_key_and_an_address_key_never_collide():
    """Двете пространства са отделни, за да не отваря едното дупка в другото."""
    assert rate_limit._identity(_request("1.2.3.4"), None).startswith("ip:")
    assert rate_limit._identity(_request("1.2.3.4"), _user("x")).startswith("u:")
