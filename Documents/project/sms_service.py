# sms_service.py — праща SMS кодове за потвърждение на телефон и възстановяване (Twilio)
import os

TWILIO_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_FROM = os.environ.get("TWILIO_FROM_NUMBER")


def send_sms(to: str, body: str) -> None:
    if not (TWILIO_SID and TWILIO_TOKEN and TWILIO_FROM):
        # Без ключове (локална разработка) — само отпечатваме кода в конзолата.
        print(f"[sms:dev] до {to}: {body}")
        return

    from twilio.rest import Client
    client = Client(TWILIO_SID, TWILIO_TOKEN)
    client.messages.create(to=to, from_=TWILIO_FROM, body=body)


def send_verification_sms(to: str, code: str) -> None:
    send_sms(to, f"Climby: твоят код за потвърждение е {code}. Важи 15 минути.")


def send_reset_sms(to: str, code: str) -> None:
    send_sms(to, f"Climby: код за нова парола — {code}. Важи 15 минути.")
