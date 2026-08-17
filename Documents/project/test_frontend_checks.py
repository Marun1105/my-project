# test_frontend_checks.py — статични проверки на frontend-а, които хващат често срещани
# и тихи счупвания: липсващ превод (показва се суровият ключ), сочене към несъществуващ
# елемент, файл извън кеша на service worker-а.
#
# Пускане:  python -m pytest test_frontend_checks.py -q
import os
import re

import pytest

FRONTEND = os.path.join(os.path.dirname(__file__), "frontend")


def _read(name):
    with open(os.path.join(FRONTEND, name), encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def html():
    return _read("index.html")


@pytest.fixture(scope="module")
def i18n():
    return _read("i18n.js")


def _dict_keys(i18n_src, lang):
    """Ключовете на един езиков речник в i18n.js."""
    start = i18n_src.index(f"{lang}: {{")
    # речникът свършва там, където започва следващият (или файлът)
    rest = i18n_src[start + 1:]
    nxt = min(
        (rest.index(f"{other}: {{") for other in ("bg", "en") if f"{other}: {{" in rest),
        default=len(rest),
    )
    block = rest[:nxt]
    return set(re.findall(r"^\s*'([^']+)':", block, re.MULTILINE))


def test_both_languages_define_the_same_keys(i18n):
    bg = _dict_keys(i18n, "bg")
    en = _dict_keys(i18n, "en")
    assert bg, "не намерих български ключове"
    assert bg == en, f"само в bg: {sorted(bg - en)} | само в en: {sorted(en - bg)}"


def test_every_key_used_in_html_exists(html, i18n):
    bg = _dict_keys(i18n, "bg")
    used = set(re.findall(r'data-i18n(?:-placeholder|-aria)?="([^"]+)"', html))
    missing = sorted(used - bg)
    assert not missing, f"липсват преводи за: {missing}"


@pytest.mark.parametrize("js_file", [
    "auth.js", "checklist.js", "history.js", "focus.js", "family.js",
    "onboarding.js", "settings.js", "scanner.js", "tutor.js", "ai-planner.js", "nav.js",
])
def test_element_ids_referenced_by_js_exist(html, js_file):
    ids_in_html = set(re.findall(r'id="([^"]+)"', html))
    src = _read(js_file)
    referenced = set(re.findall(r"\$\('([^']+)'\)", src)) | set(
        re.findall(r"getElementById\('([^']+)'\)", src)
    )
    missing = sorted(referenced - ids_in_html)
    assert not missing, f"{js_file} сочи към несъществуващи елементи: {missing}"


def test_service_worker_caches_every_local_script(html):
    sw = _read("sw.js")
    cached = set(re.findall(r"'\./([^']+)'", sw))
    scripts = set(re.findall(r'<script src="(?!http)([^"]+)"', html))
    missing = sorted(scripts - cached)
    assert not missing, f"липсват в кеша на service worker-а: {missing}"


def test_service_worker_shell_files_all_exist():
    sw = _read("sw.js")
    for entry in re.findall(r"'\./([^']+)'", sw):
        if entry:
            assert os.path.isfile(os.path.join(FRONTEND, entry)), f"липсва файл: {entry}"


def test_manifest_icons_exist():
    import json
    manifest = json.loads(_read("manifest.json"))
    for icon in manifest["icons"]:
        assert os.path.isfile(os.path.join(FRONTEND, icon["src"])), icon["src"]


def test_backend_url_is_only_defined_in_config():
    """Адресът на бекенда живее само в config.js — иначе локален тест остава забравен някъде."""
    offenders = []
    for name in os.listdir(FRONTEND):
        if not name.endswith(".js") or name == "config.js":
            continue
        src = _read(name)
        if "onrender.com" in src or "127.0.0.1" in src or "localhost" in src:
            offenders.append(name)
    assert not offenders, f"твърд адрес на бекенда в: {offenders}"


def test_config_points_at_production():
    """Проверява самата стойност, не коментара над нея (там локалният адрес е нарочно)."""
    assignment = re.search(r"window\.CLIMBY_BACKEND\s*=\s*'([^']+)'", _read("config.js"))
    assert assignment, "не намерих window.CLIMBY_BACKEND в config.js"
    url = assignment.group(1)
    assert url.startswith("https://"), f"config.js е останал насочен към локален бекенд: {url}"
