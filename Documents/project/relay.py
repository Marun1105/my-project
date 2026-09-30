# relay.py — Opus reads the page, Haiku teaches from it.
#
# Every student-facing call ran on Haiku 4.5, and a student who photographed a
# page of handwritten Bulgarian geometry was asked to type it out. Haiku could
# neither read it nor solve it. Opus could do both — measured on that very page
# (docs/superpowers/specs/2026-09-29-study-relay-design.md): it read all four
# problems, found the one whose data were insufficient, and solved the one asked
# about correctly, in 33 seconds for about six cents.
#
# So the expensive model runs once per photograph and the cheap one carries
# every turn after it:
#
#   photos ──▶ Opus reads, once ──▶ problem_briefs row ──▶ Haiku tutors from it
#   typed  ──▶ Haiku, with Opus on call as an advisor, at most once per message
#
# The numbers below are the ones that were measured, not guessed.
import re

from anthropic import APIError

READER_MODEL = "claude-opus-5"
ADVISOR_MODEL = "claude-opus-5"

# Low effort answered problem 22 correctly (30 cm², checked by hand) in 33 s.
# Medium took 48 s for the same answer; solving the whole page took 77 s, and
# the client gives up at 120.
READER_EFFORT = "low"
READER_MAX_TOKENS = 8000
# A hard stop on the read. The slowest measured read was 77 s; past this the
# caller falls back to Haiku reading the photos, which still leaves the tutor
# turn room inside the client's own limit (AI_READ_TIMEOUT_MS in net.js).
READER_TIMEOUT_S = 75

# Uncapped, the advisor took 82 s to answer one chat message. Capped at 2000
# tokens: 26 s, and it still chose the method a 7th-grader is taught.
ADVISOR_MAX_TOKENS = 2000
ADVISOR_BETA = "advisor-tool-2026-03-01"
FALLBACK_BETA = "server-side-fallback-2026-07-01"

SEARCH_MAX_USES = 2
# Решебници. Every Bulgarian textbook in print has its answers online, and an
# unsupervised search finds them in one step. The Bulgarian ones, and the
# Russian ГДЗ sites Bulgarian students also reach.
ANSWER_KEY_SITES = [
    "domashno.bg", "zadachite.net",
    "gdz.ru", "reshak.ru", "resheba.top", "skysmart.ru", "reshebnik.ru",
]

# Subjects where "the answer" exists and a worked solution is worth writing.
SOLVED_SUBJECTS = {"maths", "physics", "chemistry"}

LANGUAGE = {"en": "English", "bg": "Bulgarian"}


# ------------------------------------------------------------------ the reader

READER_SYSTEM = """You read photographed school homework for a tutor who cannot see the photo.
The student is in Bulgaria and the page is almost always in Bulgarian, including
Bulgarian maths shorthand: "ср. на BC" is the midpoint of BC, "отс." a segment,
"т." a point, S_ABC the area of triangle ABC.

Reply in exactly three parts and nothing else.

<subject>one word: maths, physics, chemistry, or other</subject>

<read>
In {language}. Every problem on the page, by its number: what is given and what
is asked. Say plainly what is illegible, cut off, or insufficient as written.
Compact — this is shown to the student so they can check you read it right.
</read>

<solution>
Only if the subject is maths, physics or chemistry, and only for the problem the
student's question is about (if the question does not say, the first complete
problem). Solve it the way a good teacher at this grade would, with the method
taught at that grade and not a more advanced one. Step by step, the reason for
each step, the final answer, a quick check of the answer, and the mistake a
student is most likely to make. Write it so a tutor who is weaker at maths than
you understands every step perfectly. Omit this part for any other subject.
</solution>"""


class ReaderFailed(Exception):
    pass


# The reader is asked for one of four words and mostly gives one, but "geometry"
# or "mathematics" must not quietly cost a student their worked solution.
_SUBJECT_ALIASES = {
    "maths": "maths", "math": "maths", "mathematics": "maths", "geometry": "maths",
    "algebra": "maths", "математика": "maths", "геометрия": "maths",
    "physics": "physics", "физика": "physics",
    "chemistry": "chemistry", "химия": "chemistry",
}


def _subject(raw):
    word = (raw or "").strip().lower().split()
    return _SUBJECT_ALIASES.get(word[0].strip(".,:;") if word else "", "other")


def _tag(text, name):
    m = re.search(rf"<{name}>\s*(.*?)\s*</{name}>", text, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else None


def read_pages(client, image_blocks, question, lang, grade=None):
    """Opus reads the photographs. Returns (brief fields, response) or raises.

    The caller treats any failure as "no brief" and falls back to Haiku reading
    the photographs itself — a student must never see the relay fail.
    """
    ask = f"Student's question: {question}"
    if grade:
        ask += f"\nThe student is in grade {grade}."
    resp = client.beta.messages.create(
        model=READER_MODEL,
        max_tokens=READER_MAX_TOKENS,
        timeout=READER_TIMEOUT_S,
        betas=[FALLBACK_BETA],
        # If Opus declines, the API re-runs the request on a fallback model in
        # the same call instead of returning nothing.
        extra_body={"fallbacks": "default"},
        output_config={"effort": READER_EFFORT},
        system=READER_SYSTEM.format(language=LANGUAGE.get(lang, "English")),
        messages=[{"role": "user", "content": list(image_blocks) + [{"type": "text", "text": ask}]}],
    )
    if resp.stop_reason == "refusal":
        raise ReaderFailed("the reader declined")
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    read = _tag(text, "read")
    if not read:
        raise ReaderFailed("the reader returned no <read> part")
    subject = _subject(_tag(text, "subject"))
    solution = _tag(text, "solution") if subject in SOLVED_SUBJECTS else None
    return {"subject": subject, "read_text": read[:20000],
            "solution_text": solution[:30000] if solution else None}, resp


# ------------------------------------------------------------------ the tutor

def tutor_tools():
    """The advisor, and a fenced web search. Both on every tutor turn."""
    return [
        {"type": "advisor_20260301", "name": "advisor", "model": ADVISOR_MODEL,
         "max_uses": 1, "max_tokens": ADVISOR_MAX_TOKENS},
        {"type": "web_search_20250305", "name": "web_search",
         "max_uses": SEARCH_MAX_USES, "blocked_domains": ANSWER_KEY_SITES},
    ]


# When to call the advisor has to be said exactly. With no instruction Haiku
# never called it — and told a 7th-grader to use coordinate geometry on an
# area-ratio problem. With this, it consulted and chose a grade-7 method.
TOOL_RULES = {
    "en": """

Your tools. The advisor is a stronger mathematician than you. Before answering a
problem that needs more than one step of reasoning — a proof, geometry, a word
problem, anything where choosing the method matters — consult the advisor once,
and follow its choice of method. Do not consult it for definitions, single facts,
chat, or a problem whose worked solution you have already been given below. Never
mention the advisor to the student.

Web search is for methods and facts — a formula, a definition, a date, how a kind
of problem is usually approached. Never search for the answer to a specific
exercise.

Always use the method taught at the student's grade, never a more advanced one.""",
    "bg": """

Твоите инструменти. Съветникът е по-силен математик от теб. Преди да отговориш на
задача, която иска повече от една стъпка разсъждение — доказателство, геометрия,
текстова задача, всичко, при което изборът на метод има значение — попитай
съветника веднъж и следвай неговия избор на метод. Не го питай за определения,
отделни факти, разговор или задача, чието решение вече ти е дадено по-долу. Никога
не споменавай съветника пред ученика.

Търсенето в интернет е за методи и факти — формула, определение, дата, как обикновено
се подхожда към такъв вид задача. Никога не търси отговора на конкретно упражнение.

Винаги използвай метода, който се учи в класа на ученика, никога по-напреднал.""",
}

BRIEF = {
    "en": """

The student photographed a page. It has been read for you, carefully, by a stronger
reader — trust this over anything you might guess:

<page>
{read}
</page>{solution}""",
    "bg": """

Ученикът е снимал страница. Прочетена е за теб, внимателно, от по-силен читател —
вярвай на това повече от всичко, което би предположил:

<page>
{read}
</page>{solution}""",
}

BRIEF_SOLUTION = {
    "en": """

A worked solution to the problem being asked about, for YOUR eyes only:

<solution>
{solution}
</solution>

Steer by it. Check the student's steps against it. Do not reveal it, or its final
answer, unless the student asks for the answer — and if they do, give it, fully
explained, so they can follow every step.""",
    "bg": """

Разработено решение на задачата, за която пита ученикът, САМО за теб:

<solution>
{solution}
</solution>

Води по него. Проверявай стъпките на ученика спрямо него. Не го показвай, нито
крайния отговор, освен ако ученикът не поиска отговора — а ако поиска, дай му го,
напълно обяснено, така че да проследи всяка стъпка.""",
}


def brief_block(brief, lang):
    lang = lang if lang in BRIEF else "en"
    solution = ""
    if brief.solution_text:
        solution = BRIEF_SOLUTION[lang].format(solution=brief.solution_text)
    return BRIEF[lang].format(read=brief.read_text, solution=solution)


# Blocks that mark the end of a tool round-trip. Haiku sometimes narrates the
# consultation before it happens — "let me consult on the best method" — and
# that sentence is not for the student.
_TOOL_RESULT_TYPES = {"advisor_tool_result", "web_search_tool_result", "server_tool_use"}


def answer_text(resp):
    """The student-facing text: everything after the last tool round-trip."""
    blocks = list(resp.content)
    last_tool = -1
    for i, b in enumerate(blocks):
        if getattr(b, "type", "") in _TOOL_RESULT_TYPES:
            last_tool = i
    after = [b for b in blocks[last_tool + 1:] if getattr(b, "type", "") == "text"]
    if not after:   # nothing after the tools — take whatever text there is
        after = [b for b in blocks if getattr(b, "type", "") == "text"]
    return "".join(b.text for b in after)
