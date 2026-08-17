# email_service.py — праща имейли за потвърждение и възстановяване на парола (Resend)
import os

import resend

RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
FROM_EMAIL = os.environ.get("RESEND_FROM", "Climby <onboarding@resend.dev>")

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY


def _wrap(title: str, code: str, footer: str) -> str:
    return f"""
    <div style="font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#f2f1ed;
                padding:28px;border-radius:14px;max-width:420px;margin:0 auto;">
      <p style="text-transform:uppercase;letter-spacing:0.14em;font-size:11px;color:#2ec25f;
                font-weight:600;margin:0 0 8px;">Climby</p>
      <h2 style="margin:0 0 14px;font-size:20px;">{title}</h2>
      <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:0 0 14px;">{code}</p>
      <p style="color:#9a9a94;font-size:13px;line-height:1.5;margin:0;">{footer}</p>
    </div>
    """


def send_email(to: str, subject: str, html: str) -> None:
    if not RESEND_API_KEY:
        # Без ключ (локална разработка) — само отпечатваме кода в конзолата.
        print(f"[email:dev] до {to}: {subject}\n{html}")
        return

    resend.Emails.send({
        "from": FROM_EMAIL,
        "to": [to],
        "subject": subject,
        "html": html,
    })


def send_verification_email(to: str, code: str) -> None:
    html = _wrap(
        "Почти стигна върха — потвърди имейла си",
        code,
        "Кодът важи 15 минути. Ако не си ти, просто игнорирай този имейл.",
    )
    send_email(to, "Твоят код за Climby", html)


def send_reset_email(to: str, code: str) -> None:
    html = _wrap(
        "Да продължим изкачването — нова парола",
        code,
        "Кодът важи 15 минути. Ако не си поискал/а това, паролата ти остава непроменена.",
    )
    send_email(to, "Възстановяване на парола — Climby", html)
