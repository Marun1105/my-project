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


# Имена на екрани, които вече не съществуват. Ключовете в i18n.js още се казват
# checklist.* и history.* — това са вътрешни имена и е нормално. Но текстът, който
# ЧОВЕКЪТ чете, не бива да сочи към екран, който го няма в менюто.
RETIRED_SCREEN_WORDS = [
    "чеклист", "Семейство", "Чеклист",
    # The Teacher tab became ClimbAI. Its title was renamed; the strings that
    # *pointed at it* — an empty state, a settings hint — were missed twice,
    # which is exactly the failure this list exists to catch.
    "Teacher tab", "раздел Учител", "раздела „Учител", "focus camera", "фокус камерата",
]


def _translation_values(i18n_src):
    """Само стойностите, не ключовете."""
    out = []
    for line in i18n_src.splitlines():
        stripped = line.strip()
        if not stripped.startswith("'") or "':" not in stripped:
            continue
        value = stripped.split("':", 1)[1].strip().rstrip(",").strip()
        if len(value) >= 2 and value[0] in "'\"":
            out.append((stripped.split("'")[1], value[1:-1]))
    return out


def test_no_text_points_at_a_screen_that_was_renamed(i18n):
    """Преименуването на менюто остави текстове, сочещи към старите имена.

    Екранът за вход казваше "пазим чеклиста и историята ти", а такива екрани вече
    няма — казват се Маршрут и Изкачени. Едно от съобщенията пък пращаше към
    „Семейство", което не е съществувало и преди това.
    """
    offenders = []
    for key, value in _translation_values(i18n):
        for word in RETIRED_SCREEN_WORDS:
            if word in value:
                offenders.append(f"{key}: …{word}…")
    assert not offenders, "текст сочи към преименуван екран: " + "; ".join(offenders[:6])


def test_every_google_string_exists_in_both_languages():
    """A key in one language and missing from the other is a blank on screen."""
    source = _read("i18n.js")
    for key in ("auth.or", "auth.google", "auth.googleFailed", "auth.roleTitle",
                "auth.roleStudent", "auth.roleParent", "auth.roleTeacher"):
        assert source.count(f"'{key}'") >= 2, f"{key} is missing from a language"


def test_the_google_button_exists_and_is_wired():
    html = _read("index.html")
    js = _read("auth.js")
    assert 'id="googleSignIn"' in html
    assert "googleSignIn" in js, "the button exists but nothing listens to it"


def test_a_sign_in_the_app_did_not_ask_for_is_ignored():
    """The nonce check is the only thing standing between a mailed climby:// link
    and a child's homework landing in a stranger's account."""
    js = _read("auth.js")
    assert "climby-oauth-nonce" in js
    assert "payload.nonce !== expected" in js, "the deep link is accepted unchecked"


def test_the_sign_in_nonce_is_not_guessable():
    """Math.random() is predictable, and this value is a security token.

    It is the only thing stopping a mailed climby:// link from signing a child's
    app into someone else's account, so it must come from the browser's real
    random source and not from a generator whose next output can be derived from
    its previous ones.
    """
    js = _read("auth.js")
    nonce_block = js[js.index("function startGoogle"):js.index("function receiveDesktopSignIn")]
    # A CALL, not the word: the comment there explains why it is not used.
    assert "Math.random(" not in nonce_block, "the nonce is guessable"
    assert "crypto.getRandomValues" in nonce_block


def test_the_google_button_starts_hidden():
    """It is revealed only after the server says the flow exists here.

    Shipped before the credentials are set, a permanently visible button teaches
    people that Climby is broken rather than that a feature is off.
    """
    html = _read("index.html")
    js = _read("auth.js")
    block = html[html.index('id="googleBlock"'):]
    assert 'class="hidden"' in block[:80], "the block is not hidden to begin with"
    assert "/auth/providers" in js, "nothing ever asks whether it is available"


def test_the_role_question_is_asked_where_it_can_be_seen():
    """#roleForm lives inside #entryGate, and signing in closes that gate.

    Showing the form without re-opening the gate asks the question into a hidden
    overlay: every Google account would silently keep the student default, which
    is precisely what this screen exists to prevent.
    """
    js = _read("auth.js")
    block = js[js.index("function showRoleChoice"):js.index("function chooseRole")]
    assert "showEntryGate()" in block, "the role screen is shown inside a closed gate"


def test_the_google_button_is_only_offered_where_it_can_finish():
    """Only the desktop shell can catch climby://auth.

    In a browser the flow reaches the callback and stops: the token has nowhere
    to go. A button that looks like it works and does not is worse than none.
    """
    js = _read("auth.js")
    block = js[js.index("function revealGoogleIfAvailable"):js.index("function startGoogle")]
    assert "CLIMBY_DESKTOP" in block, "the button would show in a browser too"


def test_read_aloud_strings_exist_in_both_languages():
    source = _read("i18n.js")
    for key in ("tutor.readAloud", "tutor.stopReading"):
        assert source.count(f"'{key}'") >= 2, f"{key} is missing from a language"


def test_read_aloud_is_attached_after_maths_is_rendered():
    """Attached after KaTeX, so what is read is what is on screen.

    And never innerText: KaTeX renders every formula twice, a hidden MathML copy
    and the visible one, so innerText would speak each equation twice.
    """
    tutor = _read("tutor.js")
    speak = _read("speak.js")
    assert tutor.index("renderMathInElement(el") < tutor.index("Speak.attach(el)")
    # The property, not the word: the comment in speak.js names innerText to say why not.
    assert ".katex-mathml" in speak and ".innerText" not in speak


def test_past_paper_strings_exist_in_both_languages():
    source = _read("i18n.js")
    for key in ("entry.paperTitle", "papers.title", "papers.page", "papers.errPaper"):
        assert source.count(f"'{key}'") >= 2, f"{key} is missing from a language"


def test_the_paper_picker_is_a_sibling_of_the_entry_stage():
    """It replaces the entry cards while open. Nested inside them, hiding the
    stage hides the picker with it — which is exactly what happened first."""
    html = _read("index.html")
    a = html.index('id="entryStage"'); b = html.index('id="paperPicker"')
    between = html[a:b]
    assert between.count("<div") == between.count("</div>"), "the picker is inside the entry stage"


def test_preference_strings_exist_in_both_languages():
    source = _read("i18n.js")
    for key in ("settings.text", "settings.reading", "settings.tutorMode", "settings.autoread", "settings.motion",
                "checklist.doneAll", "checklist.progress", "scanner.quickHint", "scanner.quickCheck"):
        assert source.count(f"'{key}'") >= 2, f"{key} is missing from a language"


def test_preferences_are_applied_before_first_paint():
    """prefs.js sets the data attributes at load, not on DOMContentLoaded — a
    large-text reader must not see the small layout flash first."""
    html = _read("index.html")
    assert html.index('<script src="prefs.js">') < html.index('<script src="i18n.js">')
    js = _read("prefs.js")
    assert "root.setAttribute('data-' + k, read(k))" in js


# ---------------------------------------------------------------------------
# The things every app has. Each of these was missing once, and each one broke
# quietly — the kind of gap nobody files a bug for, they just stop using it.
# ---------------------------------------------------------------------------


def test_every_new_script_is_cached_by_the_service_worker():
    """A script in index.html but not in sw.js is a script the app loses the
    moment it opens offline — the failure is invisible until there is no
    connection, which is precisely when it matters."""
    html = _read("index.html")
    sw = _read("sw.js")
    in_page = set(re.findall(r'<script src="([^":/]+\.js)"', html))
    for name in in_page:
        assert f"'./{name}'" in sw, f"{name} is loaded but not cached by the service worker"


def test_the_offline_bar_and_the_fast_failure_agree():
    """The bar tells the person; net.js stops the request. One without the
    other is either a lie on screen or a minute of silent waiting."""
    assert "navigator.onLine" in _read("offline.js")
    assert "navigator.onLine === false" in _read("net.js")


def test_connection_strings_exist_in_both_languages():
    source = _read("i18n.js")
    for key in ("net.offline", "net.offlineShort", "net.backOnline",
                "checklist.deleted", "checklist.undo",
                "answer.copy", "answer.copied",
                "auth.showPassword", "auth.hidePassword",
                "checklist.editHint", "checklist.saveEdit", "entry.pasteHint"):
        assert source.count(f"'{key}'") >= 2, f"{key} is missing from a language"


def test_deleting_a_task_offers_a_way_back():
    """No confirmation box, but no silent loss either: the toast carries the
    task's own text, subject and deadline, so Undo restores the same task."""
    js = _read("checklist.js")
    assert "Toast.show(window.t('checklist.deleted')" in js
    assert "addTask(t.text, t.subject, t.deadline)" in js


def test_the_chat_thread_is_kept_per_account():
    """A shared computer must not hand the next student the last one's
    conversation, so what is stored records whose it is and is checked on the
    way back in."""
    js = _read("chat.js")
    assert "saved.who !== owner()" in js
    assert "who: owner()" in js


def test_only_the_new_chat_button_throws_the_thread_away():
    """Signing in and out swaps whose thread is shown. If that path called
    reset(), it would delete the thread of the account that just arrived."""
    js = _read("chat.js")
    reset = js[js.index("function reset()"):]
    reset = reset[:reset.index("\n  }")]
    assert "removeItem(THREAD_KEY)" in reset
    clear = js[js.index("function clearView()"):]
    clear = clear[:clear.index("\n  }")]
    assert "THREAD_KEY" not in clear


def test_back_goes_to_the_previous_screen():
    """Every view leaves a history entry, and popstate puts the one behind it
    back — otherwise the back button/gesture drops out of the app entirely."""
    js = _read("nav.js")
    assert "history.pushState({ view }" in js
    assert "'popstate'" in js
    # a view that no longer exists must not open a blank screen
    assert "knownView(view)" in js


def test_a_picture_can_arrive_by_paste_or_by_drop():
    js = _read("scanner.js")
    for wiring in ("'paste'", "'drop'", "'dragenter'"):
        assert wiring in js, f"{wiring} is not wired"
    # typing in a field must keep its own paste
    assert "TEXTAREA" in js


def test_the_window_remembers_where_it_was():
    path = os.path.join(os.path.dirname(__file__), "desktop", "main.js")
    with open(path, encoding="utf-8") as f:
        js = f.read()
    assert "window-bounds.json" in js
    # a window restored onto a screen that is gone is a window you cannot find
    assert "getAllDisplays" in js
    # and Windows has no paste without a right-click menu
    assert "'context-menu'" in js


def test_open_panels_keep_the_keyboard_inside_them():
    """Tab used to walk out of Settings and down the page behind it. The trap
    loops at both ends, and closing hands focus back to whatever opened it —
    never to document.body, which is the same drop under another name."""
    js = _read("dialog.js")
    assert "e.shiftKey" in js and "last.focus()" in js and "first.focus()" in js
    assert "back !== document.body" in js
    # the panels are found by the one thing they all do: drop the hidden class
    assert "MutationObserver" in js and "attributeFilter: ['class']" in js


def test_the_settings_panel_says_what_it_is():
    html = _read("index.html")
    card = html[html.index('id="settingsOverlay"'):]
    card = card[:card.index("</h2>")]
    assert 'role="dialog"' in card
    assert 'aria-labelledby="settingsTitle"' in card and 'id="settingsTitle"' in card


# ---------------------------------------------------------------------------
# What the review of d3306ae found. Each of these shipped and had to be undone.
# ---------------------------------------------------------------------------


def test_the_copied_answer_keeps_its_line_breaks():
    """innerText on a detached clone is not the rendered text — the node was
    never laid out, so it falls back to textContent and a stepped answer pastes
    as one run-on line wearing the HTML source's indentation."""
    js = _read("copy.js")
    assert ".innerText" not in js, "innerText on a detached node does not do what it looks like"
    assert "textContent" in js and "BLOCKS" in js
    assert "querySelectorAll('li')" in js, "a list without its markers reads as loose sentences"


def test_the_copy_button_makes_room_for_itself():
    """It shares the corner with the read-aloud button, which Speak.attach
    declines to add when the system has no voice for the language. Which of the
    two cases it is has to be asked of the element, not assumed."""
    css = _read("style.css")
    assert ".answer:has(.speak-btn) .copy-btn" in css
    assert ".chat-ai .copy-btn" in css, "a chat bubble reserves a smaller strip than a card"
    assert ".chat-ai:has(.copy-btn):has(.speak-btn)" in css, "two buttons need more padding than one"


def test_a_restored_answer_has_both_buttons():
    """Otherwise the top half of a reopened thread looks unlike the bottom
    half, and the read-every-answer preference has nothing to bind to."""
    js = _read("chat.js")
    restore = js[js.index("function restore()"):]
    restore = restore[:restore.index("\n  }")]
    assert "Speak.attach" in restore and "Copy.attach" in restore


def test_only_a_file_drop_is_cancelled():
    """A preventDefault on every drop at document level also cancelled dragging
    selected text into the chat box: the drop landed nowhere."""
    js = _read("scanner.js")
    drop = js[js.index("document.addEventListener('drop'"):]
    drop = drop[:drop.index("});")]
    assert "includes('Files')" in drop
    assert drop.index("includes('Files')") < drop.index("e.preventDefault()")


def test_a_failed_task_edit_keeps_the_form_standing():
    """showListError empties the whole list, which would take the open editor
    with it — and with it the text just retyped."""
    js = _read("checklist.js")
    editor = js[js.index("function openEditor"):js.index("function buildTaskItem")]
    assert "showListError" not in editor, "the editor must report its own failure, in place"
    assert "task-edit-error" in editor


def test_the_app_moving_itself_does_not_fill_the_back_button():
    """The tour walks six screens on its own. Back afterwards should return the
    person to where they were, not replay the tour backwards."""
    nav = _read("nav.js")
    assert "record = 'push'" in nav and "record === 'replace'" in nav
    for name in ("tour.js", "phone.js"):
        js = _read(name)
        for line in js.splitlines():
            if "Nav.activate(" in line:
                assert "'replace'" in line, f"{name}: {line.strip()} records a history entry nobody asked for"


def test_the_offline_bar_makes_room_for_itself():
    """It is fixed at the top. On a phone the one thing up there is .mobile-bar,
    which holds the only way into the navigation."""
    css = _read("style.css")
    assert "body.is-offline .app-shell" in css, "nothing moved aside for the bar"
    assert "body.is-offline .entry-gate" in css


def test_a_remembered_window_fits_the_screen_it_returns_to():
    """Remembered at 2560x1400 on an external monitor and reopened on a laptop,
    the window came back larger than the display with its bottom edge off the
    end of it."""
    path = os.path.join(os.path.dirname(__file__), "desktop", "main.js")
    with open(path, encoding="utf-8") as f:
        js = f.read()
    remembered = js[js.index("function rememberedBounds()"):js.index("function createWindow()")]
    assert "Math.min(b.width, area.width)" in remembered
    assert "Math.min(b.height, area.height)" in remembered


def test_both_screens_say_which_one_they_are():
    """The chat and the photo tutor post to the same endpoint. Without this the
    server cannot tell them apart, and the chat inherits the photo rules."""
    assert "surface: 'chat'" in _read("chat.js")
    assert "surface: 'tutor'" in _read("tutor.js")


def test_the_tutor_knows_every_screen_the_app_has():
    """The prompt describes the app to the student, so it has to keep up with
    the app. Add or rename a screen and this fails until the map learns it.

    Each language is checked on its own. Searching the whole map at once let a
    rename pass unnoticed: the Bulgarian lines carry the English name in
    brackets — "Изкачени (Summited)" — so dropping Summited from the English
    half still found it in the Bulgarian one. Keeping them separate also
    enforces something worth having: the Bulgarian map names every screen in
    English too, so a student who switches language is still understood.

    The check is on the name, not the wording: the paragraph may be rewritten
    freely, but a screen cannot quietly stop existing in it."""
    html = _read("index.html")
    i18n = _read("i18n.js")
    path = os.path.join(os.path.dirname(__file__), "server.py")
    with open(path, encoding="utf-8") as f:
        server_src = f.read()
    app_map = server_src[server_src.index("APP_MAP = {"):server_src.index("SURFACE = {")]
    halves = {
        "en": app_map[app_map.index('"en": """'):app_map.index('"bg": """')],
        "bg": app_map[app_map.index('"bg": """'):],
    }
    assert len(halves["en"]) > 500 and len(halves["bg"]) > 500, "a language lost its map"

    # both dictionaries live in one file and Bulgarian comes first, so the
    # English names have to be looked for after the English one opens
    english = i18n[i18n.index("en: {"):]
    views = set(re.findall(r'id="view-([a-z]+)"', html))
    assert views, "no screens found in index.html"
    checked = 0
    for view in sorted(views):
        m = re.search(r"'nav\." + view + r"':\s*'([^']+)'", english)
        if not m:
            continue        # a screen with no menu entry of its own
        name = m.group(1)
        for lang, half in halves.items():
            assert name in half, (
                f"the {lang} half of APP_MAP in server.py has never heard of the "
                f"{name!r} screen — a student on that screen will be told about a "
                f"different app than the one they are looking at"
            )
        checked += 1
    assert checked >= 5, f"only {checked} screens were checked — the lookup is finding nothing"
