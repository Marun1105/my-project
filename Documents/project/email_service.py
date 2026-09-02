# email_service.py — праща имейли за потвърждение и възстановяване на парола (Resend)
#
# Писмата са нарочно на СВЕТЛА основа, макар приложението да е тъмно. Пощенските
# програми не са браузър: Outlook реже половината CSS, а Gmail в тъмен режим сам
# обръща цветовете и тъмните макети излизат на петна. Писмо, което не се чете, е
# дете, което не може да влезе — затова тук печели предвидимостта, а не приликата.
#
# Разположението е с таблици по същата причина. Flexbox и grid просто ги няма в
# половината пощенски програми.
import os

import resend

RESEND_API_KEY = os.environ.get("RESEND_API_KEY")

# Подателят се сменя от средата. За да стане noreply@climby.com, домейнът трябва
# първо да е потвърден в Resend (DNS записи), инак Resend отказва да прати изобщо
# и кодовете спират тихо. След потвърждаването:
#     Render → Environment → RESEND_FROM = Climby <noreply@climby.com>
FROM_EMAIL = os.environ.get("RESEND_FROM", "Climby <onboarding@resend.dev>")

# Единственият цвят в приложението значи "тук работи AI". В писмо няма AI, затова
# и цвят почти няма: само кодът е с лилаво, защото той е нещото, което се търси с
# очи. Зеленото, което стоеше тук преди, не се среща никъде другаде в Climby.
_INK = "#16161a"
_SOFT = "#5c5c66"
_LINE = "#e4e4e7"
_ACCENT = "#7c3aed"


def _shell(title: str, intro: str, middle: str, footer: str) -> str:
    """Общата рамка. `middle` е готов HTML — код, или нищо."""
    return f"""\
<!doctype html>
<html lang="bg">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f6;">
  <!-- Редът, който се вижда в списъка с писма, преди да се отвори. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{intro}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f4f4f6;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:440px;background:#ffffff;border:1px solid {_LINE};border-radius:16px;">
        <tr><td style="padding:30px 30px 8px;">
          <p style="margin:0 0 22px;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                    letter-spacing:.16em;text-transform:uppercase;color:{_SOFT};">Climby</p>
          <h1 style="margin:0 0 10px;font:650 21px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                     color:{_INK};">{title}</h1>
          <p style="margin:0;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                    color:{_SOFT};">{intro}</p>
        </td></tr>
        {middle}
        <tr><td style="padding:8px 30px 30px;">
          <p style="margin:0;padding-top:18px;border-top:1px solid {_LINE};
                    font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                    color:{_SOFT};">{footer}</p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font:400 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
                color:#9a9aa4;">Climby — изкачи се по своя път към успеха</p>
    </td></tr>
  </table>
</body>
</html>"""


def _code_block(code: str) -> str:
    """Кодът е единственото, което се търси с очи — затова стои сам, едър и с въздух."""
    return f"""\
        <tr><td style="padding:22px 30px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background:#faf7ff;border:1px solid #e6d9ff;border-radius:12px;">
            <tr><td align="center" style="padding:18px 12px;">
              <span style="font:700 32px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                           letter-spacing:.28em;color:{_ACCENT};padding-left:.28em;">{code}</span>
            </td></tr>
          </table>
        </td></tr>"""


# Кодът НИКОГА не влиза в темата. Темата се показва в известието на заключен
# екран, а кодът за нова парола сам по себе си стига за превземане на профил:
# някой, вдигнал чужд телефон, го прочита, без изобщо да го отключва. Спестените
# две секунди не струват толкова.
def send_email(to: str, subject: str, html: str, text: str = "") -> None:
    if not RESEND_API_KEY:
        # Без ключ (локална разработка) — само отпечатваме кода в конзолата.
        print(f"[email:dev] до {to}: {subject}\n{text or html}")
        return

    # Акаунтът вече е записан, когато стигаме дотук. Ако Resend откаже (изтекъл
    # ключ, спрян домейн, мрежа), пропадналата заявка не бива да изглежда като
    # пропаднала регистрация — иначе човекът вижда грешка, акаунтът му все пак
    # съществува и опитът пак му казва "вече има акаунт с този имейл".
    try:
        payload = {"from": FROM_EMAIL, "to": [to], "subject": subject, "html": html}
        # Текстовият вариант не е украса: пощенските филтри гледат за него, а
        # четците на екран го предпочитат пред таблици.
        if text:
            payload["text"] = text
        resend.Emails.send(payload)
    except Exception as err:
        print(f"[email] изпращането до {to} не мина: {err!r}")


def send_verification_email(to: str, code: str) -> None:
    html = _shell(
        "Потвърди имейла си",
        "Още една стъпка и си вътре. Въведи този код в Climby:",
        _code_block(code),
        "Кодът важи 15 минути. Ако не си се регистрирал/а ти, просто изтрий това писмо — "
        "нищо няма да се случи.",
    )
    text = (
        f"Потвърди имейла си\n\nТвоят код за Climby: {code}\n\n"
        "Кодът важи 15 минути. Ако не си се регистрирал/а ти, изтрий това писмо."
    )
    send_email(to, "Твоят код за Climby", html, text)


def send_account_exists_email(to: str) -> None:
    """Пращаме го, когато някой се "регистрира" с адрес, който вече има акаунт.

    Екранът не казва дали адресът е зает — иначе всеки можеше да провери кое дете
    има профил в Climby, просто като подаде адреса му. Но детето, което е забравило,
    че вече се е регистрирало, не бива да остане без отговор: то получава писмо и
    от него разбира какво да направи.
    """
    html = _shell(
        "Вече имаш профил",
        "Някой — най-вероятно ти — опита да направи нов профил с този адрес.",
        "",  # тук няма код: празният блок оставяше зейнала дупка в старото писмо
        "Профилът ти си стои. Влез с паролата си, а ако си я забравил/а, натисни "
        "„Забравена парола“ в Climby. Ако не си бил/а ти, спокойно изтрий писмото — "
        "нищо не е променено.",
    )
    text = (
        "Вече имаш профил в Climby\n\n"
        "Някой опита да направи нов профил с този адрес. Профилът ти си стои — "
        "влез с паролата си, или използвай „Забравена парола“.\n\n"
        "Ако не си бил/а ти, нищо не е променено."
    )
    send_email(to, "Вече имаш профил в Climby", html, text)


def send_reset_email(to: str, code: str) -> None:
    html = _shell(
        "Нова парола",
        "Случва се на всеки. Въведи този код в Climby и си избери нова:",
        _code_block(code),
        "Кодът важи 15 минути. Ако не си поискал/а нова парола, старата ти остава "
        "непроменена — можеш да изтриеш писмото.",
    )
    text = (
        f"Нова парола за Climby\n\nКод: {code}\n\n"
        "Кодът важи 15 минути. Ако не си поискал/а това, паролата ти остава непроменена."
    )
    send_email(to, "Възстановяване на парола — Climby", html, text)
