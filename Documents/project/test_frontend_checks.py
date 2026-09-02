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


def test_the_local_address_is_only_used_when_actually_running_locally():
    """Локалният адрес вече стои в config.js за постоянно — но зад проверка.

    Така никой не пипа файла на ръка и няма какво да се забрави върнато. Тестът
    пази точно това: стойността по подразбиране да е продукцията, а локалният
    адрес да се стига само през проверка на location.hostname. Махне ли някой
    проверката, изданието тръгва срещу изключен компютър.
    """
    src = _read("config.js")
    default = re.search(r"window\.CLIMBY_BACKEND\s*=\s*'([^']+)'", src)
    assert default and default.group(1) == PRODUCTION_BACKEND, (
        "първото присвояване в config.js трябва да е продукцията"
    )
    if "127.0.0.1" in src or "localhost" in src:
        assert "location.hostname" in src, (
            "config.js споменава локален адрес, но не проверява откъде е отворена страницата"
        )
        # локалният адрес не бива да е безусловен
        for line in src.splitlines():
            stripped = line.strip()
            if stripped.startswith("window.CLIMBY_BACKEND") and ("127.0.0.1" in stripped or "localhost" in stripped):
                raise AssertionError("локалният адрес се присвоява безусловно: " + stripped)


def test_the_csp_allows_the_local_backend_config_points_at():
    """Ако config.js сочи към localhost при разработка, правилото трябва да го пуска.

    Двете се разминаваха: подсказката казваше да се ползва 127.0.0.1, а CSP го
    отказваше. Тогава нищо не работи и нищо не обяснява защо.
    """
    html = _read("index.html")
    # Търси се в самото правило, а не в коментара над него — там думата
    # "connect-src" също се среща и мълчаливо подменяше проверката.
    tag = re.search(r'<meta http-equiv="Content-Security-Policy" content="(.*?)"', html, re.S)
    assert tag, "не намерих CSP meta в index.html"
    csp = re.search(r"connect-src([^;]*);", tag.group(1))
    assert csp, "не намерих connect-src в CSP"
    connect = csp.group(1)
    for origin in ("http://127.0.0.1:8000", "http://localhost:8000"):
        assert origin in connect, f"connect-src не пуска {origin}, а config.js го ползва локално"


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


# ---------------------------------------------------------------------------
# phone_page.html — визьорът на телефона
#
# Страницата не се вижда от нито един друг тест: test_devices.py говори с API-то,
# а тукашните проверки дотук гледат frontend/. Тя обаче е единственият екран,
# който детето вижда на телефона си, и се сервира от сървъра — счупи ли се, няма
# как да се забележи от компютъра.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def phone_page():
    with open(os.path.join(os.path.dirname(__file__), "phone_page.html"), encoding="utf-8") as f:
        return f.read()


def test_phone_page_keeps_a_way_to_shoot_without_the_in_page_camera(phone_page):
    """Отказан достъп до камерата не бива да е задънена улица.

    Визьорът иска разрешение, а разрешение се отказва — от самия човек, от
    настройка на браузъра, от служебен телефон. Ако тогава остане само визьор,
    екранът показва празно място и нито един начин да се снима.
    """
    assert 'id="shot"' in phone_page, "резервното поле за файл е махнато"
    assert 'capture="environment"' in phone_page, "резервният път вече не вика камерата на телефона"
    assert "useFallback" in phone_page, "няма преминаване към резервния път"


def test_phone_page_stops_the_camera_when_it_is_not_looking(phone_page):
    """Камерата да не работи в джоба.

    Телефонът се заключва и прибира далеч по-често, отколкото страницата се
    затваря. Останел ли потокът жив, лампичката до камерата свети, а батерията
    се топи, докато никой не гледа.
    """
    for hook in ("visibilitychange", "pagehide", "stopCamera"):
        assert hook in phone_page, f"липсва {hook} — камерата остава пусната"


def test_phone_page_asks_for_a_big_frame(phone_page):
    """Визьорът вече струва качество — да не струва и размер.

    Кадърът от видеопоток е без обработката, която телефонът прави на истинската
    снимка. Дребният печатен текст е първото, което се губи, затова искаме
    възможно най-едрия кадър — и то с ideal, за да даде телефонът каквото има,
    вместо да откаже изобщо.
    """
    assert "width: { ideal: 2560 }" in phone_page
    assert "exact:" not in phone_page, "exact отказва камерата вместо да ѝ поиска по-малко"


def test_phone_page_has_one_place_that_encodes_a_frame(phone_page):
    """Визьорът и файлът да минават през едно кодиране.

    Два почти еднакви екземпляра се разминават тихо: единият получава нов таван
    за размера, другият остава със стария, и разликата се вижда чак когато
    сървърът откаже по-голямата снимка.
    """
    assert phone_page.count("function encodeCanvas") == 1
    assert phone_page.count("toDataURL") == 1, "кодира се на повече от едно място"


def test_phone_page_still_loads_nothing_from_outside(phone_page):
    """Един файл, нула външни заявки — това е причината да се отваря на слаб Wi-Fi."""
    assert "https://" not in phone_page.split("<style>")[1], "външен адрес в страницата"
    assert "<script src" not in phone_page, "външен скрипт в страницата"


def test_phone_page_does_not_use_the_dollar_helper_before_it_exists(phone_page):
    """`$` е var, не функция-декларация — преди присвояването си е undefined.

    Извикана по-рано, тя хвърля TypeError още при вдигането на страницата и
    екранът остава завинаги на „Зареждане…". Нищо друго не хваща това: файлът
    е синтактично редовен, тестовете на API-то минават, а грешката се вижда
    само в конзолата на телефона — където никой не гледа.
    """
    marker = "var $ = function"
    assert marker in phone_page, "помощникът $ е преименуван — проверката трябва да се обнови"
    before = phone_page[:phone_page.index(marker)]
    # интересува ни само скриптът, не и разметката отгоре
    script_start = before.index("<script>")
    early = [line.strip() for line in before[script_start:].splitlines() if "$('" in line]
    assert not early, "\n".join(["$ се вика, преди да съществува:"] + early)


def test_phone_page_never_leaves_a_promise_rejection_unhandled(phone_page):
    """applyConstraints не хвърля, а връща отхвърлено обещание.

    try/catch около него не хваща нищо, а всеки апарат без непрекъснат фокус
    или без лампа оставя необработено отхвърляне при всяко пускане на камерата.
    """
    for line in phone_page.splitlines():
        if "applyConstraints" in line:
            assert "Promise.resolve" in line or ".catch" in line or "return" in line, (
                "applyConstraints без .catch: " + line.strip()
            )
