# email_service.py — verification and password-reset email (Resend)
#
# These messages are deliberately on a LIGHT background even though the app is
# dark. Mail clients are not browsers: Outlook drops half of any stylesheet, and
# Gmail in dark mode inverts colours on its own, which turns dark layouts into
# a patchwork. A message that cannot be read is a student who cannot get in, so
# predictability wins here over matching the product.
#
# The layout is table-based for the same reason. Flexbox and grid simply do not
# exist in half of the mail clients in use.
import os

import resend

RESEND_API_KEY = os.environ.get("RESEND_API_KEY")

# The sender is set from the environment. Before it can become
# noreply@climby.com, the domain has to be verified in Resend (DNS records);
# without that Resend refuses to send at all and the codes stop silently.
# Once verified:
#     Render → Environment → RESEND_FROM = Climby <noreply@climby.com>
FROM_EMAIL = os.environ.get("RESEND_FROM", "Climby <onboarding@resend.dev>")

# The single accent colour in the product means "AI is working here". There is
# no AI in an email, so there is almost no colour: only the code is violet,
# because the code is the one thing the reader is hunting for.
_INK = "#16161a"
_SOFT = "#5c5c66"
_LINE = "#e4e4e7"
_ACCENT = "#7c3aed"


def _shell(title: str, intro: str, middle: str, footer: str) -> str:
    """The shared frame. `middle` is ready-made HTML — a code block, or nothing."""
    return f"""\
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f6;">
  <!-- The preview line shown in the inbox list, before the message is opened. -->
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
                color:#9a9aa4;">Climby — climb your way to success</p>
    </td></tr>
  </table>
</body>
</html>"""


def _code_block(code: str) -> str:
    """The code is the only thing being hunted for, so it stands alone and large."""
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


# The code NEVER goes in the subject line. Subjects appear in lock-screen
# notifications, and a password-reset code is on its own enough to take over an
# account: anyone who picks up the phone reads it without unlocking anything.
# The two seconds saved are not worth that.
# Whether messages are actually leaving. A silent failure is more dangerous than
# a loud one: while this went uncounted, registration answered "check your email"
# to people nothing had ever been sent to. /healthz reports it, so the outside
# monitor can see it too.
_delivery = {"sent": 0, "failed": 0, "last_error": None}


def delivery_status() -> dict:
    """How sending is going. Read by /healthz."""
    state = "failing" if _delivery["failed"] else ("ok" if _delivery["sent"] else "idle")
    return {"state": state, **_delivery}


# Resend refuses to write to anyone else's address until the domain is verified:
# from onboarding@resend.dev you may only mail the account owner, and every other
# recipient is a 403. This is not a temporary error and will not clear on its
# own, so it is recognised separately and says what to do about it.
_SANDBOX_HINT = (
    "Resend will not write to other people's addresses from {sender}. Until a "
    "domain is verified in Resend, only you receive codes — for everyone else "
    "registration looks successful and no message is ever sent. Verify a domain "
    "and set RESEND_FROM in the Render environment."
)


def _looks_like_the_sandbox_wall(err: Exception) -> bool:
    text = repr(err).lower()
    return "403" in text or "testing emails" in text or "verify a domain" in text


def send_email(to: str, subject: str, html: str, text: str = "") -> None:
    if not RESEND_API_KEY:
        # No key (local development) — just print the code to the console.
        print(f"[email:dev] to {to}: {subject}\n{text or html}")
        return

    # The account already exists by the time we get here. If Resend refuses
    # (expired key, suspended domain, network), the failed request must not look
    # like a failed registration — otherwise the user sees an error, their
    # account exists anyway, and the retry tells them the email is taken.
    try:
        payload = {"from": FROM_EMAIL, "to": [to], "subject": subject, "html": html}
        # The plain-text alternative is not decoration: spam filters look for it,
        # and screen readers prefer it to a table layout.
        if text:
            payload["text"] = text
        resend.Emails.send(payload)
        _delivery["sent"] += 1
    except Exception as err:
        _delivery["failed"] += 1
        _delivery["last_error"] = repr(err)[:300]
        if _looks_like_the_sandbox_wall(err):
            print("[email] " + _SANDBOX_HINT.format(sender=FROM_EMAIL), flush=True)
        print(f"[email] delivery to {to} FAILED "
              f"({_delivery['failed']} so far): {err!r}", flush=True)


def send_verification_email(to: str, code: str) -> None:
    html = _shell(
        "Confirm your email address",
        "One more step and you are in. Enter this code in Climby:",
        _code_block(code),
        "The code is valid for 15 minutes. If you did not create this account, "
        "you can safely delete this message — nothing will happen.",
    )
    text = (
        f"Confirm your email address\n\nYour Climby code: {code}\n\n"
        "The code is valid for 15 minutes. If you did not create this account, "
        "delete this message."
    )
    send_email(to, "Your Climby code", html, text)


def send_account_exists_email(to: str) -> None:
    """Sent when someone "registers" with an address that already has an account.

    The screen never says whether an address is taken — otherwise anyone could
    check which child has a Climby account simply by submitting their address.
    But a child who has forgotten they already signed up should not be left
    without an answer: they receive this and learn what to do.
    """
    html = _shell(
        "You already have an account",
        "Someone — most likely you — tried to create a new account with this address.",
        "",  # no code here: an empty block left a gap in the older design
        "Your account is untouched. Sign in with your password, or use "
        "“Forgot password” in Climby if you no longer remember it. If this "
        "was not you, you can safely delete this message — nothing has changed.",
    )
    text = (
        "You already have a Climby account\n\n"
        "Someone tried to create a new account with this address. Your account is "
        "untouched — sign in with your password, or use “Forgot password”.\n\n"
        "If this was not you, nothing has changed."
    )
    send_email(to, "You already have a Climby account", html, text)


def send_reset_email(to: str, code: str) -> None:
    html = _shell(
        "Set a new password",
        "It happens to everyone. Enter this code in Climby and choose a new one:",
        _code_block(code),
        "The code is valid for 15 minutes. If you did not ask for a new password, "
        "your current one is unchanged and you can delete this message.",
    )
    text = (
        f"Set a new Climby password\n\nCode: {code}\n\n"
        "The code is valid for 15 minutes. If you did not ask for this, your "
        "password is unchanged."
    )
    send_email(to, "Reset your Climby password", html, text)
