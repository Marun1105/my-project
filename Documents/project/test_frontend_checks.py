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


# HTML-ските ключове се проверяват по-горе, но модулите викат t('...') и от кода —
# сгрешен ключ там също стига до ученика като суров текст, само че по-рядко се вижда.
def test_every_key_used_in_js_exists(i18n):
    bg = _dict_keys(i18n, "bg")
    missing = {}
    for js_file in _js_modules():
        if js_file == "i18n.js":
            continue  # тук ключовете се дефинират, не се ползват
        used = set(re.findall(r"t\('([a-zA-Z0-9._]+)'", _read(js_file)))
        absent = sorted(used - bg)
        if absent:
            missing[js_file] = absent
    assert not missing, f"липсват преводи за ключове от кода: {missing}"


# Изброяването на файловете на ръка се разминава с папката: classes.js и theme.js
# стояха непроверени, защото списъкът не беше пипан, откакто ги има. Затова се чете
# от диска — нов модул влиза в проверката още щом се появи.
# sw.js работи в service worker и няма document, затова отпада.
def _js_modules():
    return sorted(
        f for f in os.listdir(FRONTEND)
        if f.endswith(".js") and f != "sw.js"
    )


@pytest.mark.parametrize("js_file", _js_modules())
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


PRODUCTION_BACKEND = "https://my-project-0gyk.onrender.com"


def test_config_points_at_production():
    """Проверява самата стойност, не коментара над нея (там локалният адрес е нарочно)."""
    assignment = re.search(r"window\.CLIMBY_BACKEND\s*=\s*'([^']+)'", _read("config.js"))
    assert assignment, "не намерих window.CLIMBY_BACKEND в config.js"
    url = assignment.group(1)
    # Само "започва с https" пропускаше и адреса на друг сървър — например копие
    # за проба. Тестът е тук именно за да не тръгне издание срещу чужда база, а
    # това се познава само по целия адрес.
    assert url == PRODUCTION_BACKEND, (
        f"config.js сочи към {url}, а не към продукцията {PRODUCTION_BACKEND}"
    )


def _our_modules():
    """Модулите, писани в този проект: `const X = (() => {` на най-горно ниво."""
    found = {}
    for name in sorted(os.listdir(FRONTEND)):
        if not name.endswith(".js"):
            continue
        for match in re.finditer(r"^const ([A-Z]\w*) = \(\(\) => \{", _read(name), re.MULTILINE):
            found[match.group(1)] = name
    return found


def test_modules_read_through_window_are_actually_put_on_window():
    """`const X = ...` на най-горно ниво НЕ става window.X — а кодът разчиташе, че става.

    Това мълчи по най-лошия начин: `window.Auth && Auth.isLoggedIn()` просто
    решава, че никой не е влязъл, и продължава. Заради него фокус сесиите не се
    записваха на нито един влязъл ученик, а менюто не скриваше чуждите роли.
    Нищо не гърми, нищо не се вижда в конзолата.
    """
    modules = _our_modules()
    assert "Auth" in modules, "не намерих модулите — проверката е безполезна"

    sources = {name: _read(name) for name in os.listdir(FRONTEND) if name.endswith(".js")}
    everything = "\n".join(sources.values())

    missing = []
    for module, own_file in modules.items():
        if not re.search(rf"\bwindow\.{module}\b(?!\s*=)", everything):
            continue  # никой не го чете през window — няма какво да се чупи
        if f"window.{module} = {module};" not in sources[own_file]:
            missing.append(f"{module} ({own_file})")

    assert not missing, (
        "четат се през window, но никога не се слагат на window: " + ", ".join(missing)
    )
