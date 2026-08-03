# tutor.py — photograph a page, ask questions about it, get answers in Bulgarian
import base64
import sys
from pathlib import Path

import cv2
from anthropic import Anthropic

client = Anthropic()


def load_image(path: Path) -> str:
    """Read the photo, downscale it, return base64 JPEG — same as ingest.py."""
    img = cv2.imread(str(path))
    if img is None:
        print(f"Не мога да отворя снимката: {path}")
        sys.exit(1)

    h, w = img.shape[:2]
    scale = 1600 / max(h, w)
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
    return base64.b64encode(jpg).decode()


SYSTEM = """Ти си учител по математика. Пред теб е снимка на страница от български учебник.

Помагаш на ученик да реши задачите на страницата. Правила:
- Обяснявай на български, стъпка по стъпка, ясно и просто.
- Не давай само отговора — покажи как се стига до него, за да се научи ученикът.
- Ако задачата има диаграма или чертеж, който не се вижда ясно, кажи го, не отгатвай.
- Ако ученикът покаже своето решение, провери го и посочи къде точно е сгрешил."""


def main():
    if len(sys.argv) < 2:
        print("Използване: python tutor.py <снимка.jpg>")
        sys.exit(1)

    image_b64 = load_image(Path(sys.argv[1]))
    print("Страницата е заредена. Питай нещо (или 'изход' за край).\n")

    # The conversation history — the image goes in the first message,
    # then every question and answer is appended so the model remembers.
    messages = [{
        "role": "user",
        "content": [
            {"type": "image", "source": {
                "type": "base64", "media_type": "image/jpeg", "data": image_b64}},
            {"type": "text", "text": "Това е страницата. Ще ти задам въпроси за нея."},
        ],
    }]

    # Get the model to acknowledge the page once, so the loop is clean.
    messages.append({"role": "assistant", "content": "Готов съм. Какъв е въпросът ти?"})

    while True:
        question = input("Ти: ").strip()
        if question.lower() in ("изход", "exit", "quit", ""):
            print("Довиждане!")
            break

        messages.append({"role": "user", "content": question})

        resp = client.messages.create(
            model="claude-sonnet-5",
            max_tokens=1500,
            system=SYSTEM,
            messages=messages,
        )
        answer = "".join(b.text for b in resp.content if b.type == "text")
        if not answer:
            answer = "(no text returned — try asking again)"

        print(f"\nУчител: {answer}\n")
        messages.append({"role": "assistant", "content": answer})


if __name__ == "__main__":
    main()