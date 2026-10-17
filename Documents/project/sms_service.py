# sms_service.py — праща SMS кодове за потвърждение на телефон и възстановяване (Twilio)
import os
import logging

TWILIO_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_FROM = os.environ.get("TWILIO_FROM_NUMBER")
logger = logging.getLogger(__name__)


def send_sms(to: str, body: str) -> None:
    if not (TWILIO_SID and TWILIO_TOKEN and TWILIO_FROM):
        if os.environ.get("RENDER") or os.environ.get("CLIMBY_ENV") == "production":
            raise RuntimeError("SMS delivery is not configured.")
        # Local development only; never report a successful production send when
        # the provider credentials are absent.
        logger.info("[sms:dev] to %s: %s", to, body)
        return

    try:
        from twilio.rest import Client
        client = Client(TWILIO_SID, TWILIO_TOKEN)
        client.messages.create(to=to, from_=TWILIO_FROM, body=body)
    except Exception as err:
        logger.exception("SMS delivery failed.")
        raise RuntimeError("SMS delivery failed.") from err


def send_verification_sms(to: str, code: str) -> None:
    send_sms(to, f"Climby: твоят код за потвърждение е {code}. Важи 15 минути.")


def send_reset_sms(to: str, code: str) -> None:
    send_sms(to, f"Climby: код за нова парола — {code}. Важи 15 минути.")
