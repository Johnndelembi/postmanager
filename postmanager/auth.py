"""Phone verification and signed sessions, adapted from SMS Desk."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import http.client
import http.cookies
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request

from .db import connect


OTP_TTL_SECONDS = 60
OTP_RESEND_SECONDS = 60
OTP_HOURLY_LIMIT = 4
OTP_MAX_ATTEMPTS = 5
MAX_OTP_REQUESTS_PER_IP_HOUR = 30
DEFAULT_OTP_DAILY_LIMIT = 1000
SESSION_IDLE_SECONDS = 24 * 60 * 60
COOKIE_NAME = "postmanager_session"
BEEM_SEND_URL = "https://apisms.beem.africa/v1/send"
UNCERTAIN_SEND = "Beem did not confirm whether it accepted this verification code. Check before requesting another code."


class AuthError(Exception):
    def __init__(self, status: int, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


class _DeliveryError(AuthError):
    def __init__(self, message: str, *, uncertain: bool):
        super().__init__(502, message)
        self.uncertain = uncertain


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise AuthError(503, f"{name} is not configured.")
    return value


def _secret() -> bytes:
    value = _required_env("SESSION_SECRET").encode("utf-8")
    if len(value) < 32:
        raise AuthError(503, "SESSION_SECRET must be at least 32 bytes.")
    return value


def normalize_phone(value: object) -> str:
    phone = re.sub(r"[\s().-]", "", str(value or "").strip())
    if phone.startswith("+"):
        phone = phone[1:]
    if phone.startswith("0") and not phone.startswith("00"):
        phone = "255" + phone[1:]
    if not re.fullmatch(r"[0-9]{8,15}", phone):
        raise AuthError(400, "Enter a valid phone number with its country code, or a local number starting with 0.")
    return phone


def _otp_digest(phone: str, code: str) -> str:
    return hmac.new(_secret(), f"otp:{phone}:{code}".encode(), hashlib.sha256).hexdigest()


def _daily_limit() -> int:
    try:
        limit = int(os.environ.get("OTP_DAILY_LIMIT", str(DEFAULT_OTP_DAILY_LIMIT)))
    except ValueError as exc:
        raise AuthError(503, "OTP_DAILY_LIMIT must be a positive integer.") from exc
    if limit < 1:
        raise AuthError(503, "OTP_DAILY_LIMIT must be a positive integer.")
    return limit


def _reserve_ip_attempt(db, client_ip: str, now: int) -> None:
    if not client_ip:
        return
    ip_hash = hmac.new(_secret(), f"ip:{client_ip}".encode(), hashlib.sha256).hexdigest()
    window_start = now - now % 3600
    db.execute("DELETE FROM otp_ip_rate_limits WHERE window_start < %s", (window_start - 24 * 3600,))
    row = db.execute(
        """INSERT INTO otp_ip_rate_limits(ip_hash, window_start, attempts)
           VALUES (%s, %s, 1)
           ON CONFLICT (ip_hash, window_start) DO UPDATE
           SET attempts = otp_ip_rate_limits.attempts + 1
           WHERE otp_ip_rate_limits.attempts < %s
           RETURNING attempts""",
        (ip_hash, window_start, MAX_OTP_REQUESTS_PER_IP_HOUR),
    ).fetchone()
    if not row:
        raise AuthError(429, "Too many verification codes were requested from this network. Try again in an hour.",
                        max(1, window_start + 3600 - now))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _send_code(phone: str, code: str, source: str, credentials: str) -> None:
    encoded = base64.b64encode(credentials.encode()).decode("ascii")
    payload = {
        "source_addr": source,
        "schedule_time": "",
        "encoding": 0,
        "message": f"Your Postmanager verification code is {code}. It expires in 60 seconds.",
        "recipients": [{"recipient_id": 1, "dest_addr": phone}],
    }
    request = urllib.request.Request(
        BEEM_SEND_URL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Authorization": "Basic " + encoded, "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=20) as response:
            raw = response.read(64 * 1024)
    except urllib.error.HTTPError as exc:
        # A server error can happen after Beem accepted the SMS; keep the challenge.
        if exc.code >= 500:
            raise _DeliveryError(UNCERTAIN_SEND, uncertain=True) from exc
        raise _DeliveryError("Beem rejected the verification code request.", uncertain=False) from exc
    except (OSError, http.client.HTTPException) as exc:
        raise _DeliveryError(UNCERTAIN_SEND, uncertain=True) from exc
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise _DeliveryError(UNCERTAIN_SEND, uncertain=True) from exc
    if not isinstance(data, dict):
        raise _DeliveryError(UNCERTAIN_SEND, uncertain=True)
    if data.get("successful") is False:
        raise _DeliveryError("Beem could not send the verification code.", uncertain=False)


def request_otp(phone_value: object, client_ip: str) -> dict:
    phone = normalize_phone(phone_value)
    source = _required_env("BEEM_SOURCE_ADDR")
    credentials = _required_env("BEEM_AUTHORIZATION")
    key, separator, api_secret = credentials.partition(":")
    if not separator or not key or not api_secret:
        raise AuthError(503, "BEEM_AUTHORIZATION must contain an API key and secret separated by a colon.")
    now = int(time.time())
    code = f"{secrets.randbelow(1_000_000):06d}"
    with connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (phone,))
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("postmanager:otp:daily",))
        _reserve_ip_attempt(db, client_ip, now)
        db.execute("DELETE FROM otp_challenges WHERE sent_at < %s", (now - 24 * 3600,))
        daily = db.execute(
            "SELECT COUNT(*) AS count, MIN(sent_at) AS oldest FROM otp_challenges WHERE sent_at > %s",
            (now - 24 * 3600,),
        ).fetchone()
        if daily["count"] >= _daily_limit():
            wait = max(1, daily["oldest"] + 24 * 3600 - now)
            raise AuthError(429, "The daily verification-code limit has been reached. Try again later.", wait)
        latest = db.execute(
            "SELECT sent_at FROM otp_challenges WHERE phone = %s ORDER BY sent_at DESC, id DESC LIMIT 1",
            (phone,),
        ).fetchone()
        recent = db.execute(
            "SELECT COUNT(*) AS count FROM otp_challenges WHERE phone = %s AND sent_at > %s",
            (phone, now - 3600),
        ).fetchone()
        if latest and now - latest["sent_at"] < OTP_RESEND_SECONDS:
            wait = max(1, OTP_RESEND_SECONDS - (now - latest["sent_at"]))
            raise AuthError(429, f"Please wait {wait} seconds before requesting another code.", wait)
        if recent["count"] >= OTP_HOURLY_LIMIT:
            wait = max(1, latest["sent_at"] + 3600 - now) if latest else 3600
            raise AuthError(429, "Too many codes requested. Try again in an hour.", wait)
        challenge_id = db.execute(
            "INSERT INTO otp_challenges(phone, otp_hash, sent_at, expires_at) VALUES (%s, %s, %s, %s) RETURNING id",
            (phone, _otp_digest(phone, code), now, now + OTP_TTL_SECONDS),
        ).fetchone()["id"]
    try:
        _send_code(phone, code, source, credentials)
    except _DeliveryError as exc:
        if not exc.uncertain:
            with connect() as db:
                db.execute("DELETE FROM otp_challenges WHERE id = %s", (challenge_id,))
        raise
    timestamp = int(time.time())
    return {
        "ok": True,
        "challenge_id": challenge_id,
        "expires_in": max(0, now + OTP_TTL_SECONDS - timestamp),
        "resend_in": max(0, now + OTP_RESEND_SECONDS - timestamp),
    }


def verify_otp(phone_value: object, code_value: object) -> dict:
    phone = normalize_phone(phone_value)
    code = str(code_value or "").strip()
    if not re.fullmatch(r"[0-9]{6}", code):
        raise AuthError(400, "Enter the six-digit code from your SMS.")
    now = int(time.time())
    with connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (phone,))
        challenge = db.execute(
            """SELECT id, otp_hash, sent_at, expires_at, attempts FROM otp_challenges
               WHERE phone = %s AND used_at IS NULL ORDER BY sent_at DESC, id DESC LIMIT 1 FOR UPDATE""",
            (phone,),
        ).fetchone()
        if not challenge or challenge["expires_at"] <= now or challenge["sent_at"] + OTP_TTL_SECONDS <= now:
            raise AuthError(400, "That code has expired. Request a new one.")
        if challenge["attempts"] >= OTP_MAX_ATTEMPTS:
            raise AuthError(429, "Too many incorrect codes. Request a new one in a minute.")
        if not hmac.compare_digest(challenge["otp_hash"], _otp_digest(phone, code)):
            db.execute("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = %s", (challenge["id"],))
            user = None  # Commit the failed attempt before returning its error.
        else:
            db.execute("UPDATE otp_challenges SET used_at = %s WHERE id = %s", (now, challenge["id"]))
            db.execute("INSERT INTO users(phone, created_at, last_activity_at) VALUES (%s, %s, %s) ON CONFLICT (phone) DO NOTHING",
                       (phone, now, now))
            user = db.execute(
                "UPDATE users SET last_activity_at = GREATEST(last_activity_at, %s) WHERE phone = %s RETURNING id, phone",
                (now, phone),
            ).fetchone()
    if user is None:
        raise AuthError(400, "That code does not match. Check the SMS and try again.")
    return {"id": user["id"], "phone": user["phone"]}


def get_user(user_id: int) -> dict | None:
    with connect() as db:
        user = db.execute("SELECT id, phone FROM users WHERE id = %s", (user_id,)).fetchone()
    return {"id": user["id"], "phone": user["phone"]} if user else None


def make_session(user_id: int) -> str:
    # shortcut: copied stateless cookies stay valid until expiry; add stored sessions if immediate revocation is needed.
    if user_id <= 0:
        raise ValueError("user_id must be positive")
    payload = f"{user_id}:{int(time.time()) + SESSION_IDLE_SECONDS}".encode("ascii")
    value = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    signature = hmac.new(_secret(), f"session:{value}".encode("ascii"), hashlib.sha256).hexdigest()
    return value + "." + signature


def read_session(token: str | None) -> int | None:
    if not token or len(token) > 512 or "." not in token:
        return None
    try:
        value, signature = token.rsplit(".", 1)
        expected = hmac.new(_secret(), f"session:{value}".encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        payload = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("ascii")
        user_id, expires = payload.split(":", 1)
        now = int(time.time())
        if not user_id.isdecimal() or int(user_id) <= 0 or not expires.isdecimal():
            return None
        if int(expires) < now or int(expires) > now + SESSION_IDLE_SECONDS:
            return None
        return int(user_id)
    except (ValueError, UnicodeError, binascii.Error):
        return None


def session_cookie(token: str, secure: bool, max_age: int = SESSION_IDLE_SECONDS) -> str:
    cookie = http.cookies.SimpleCookie()
    cookie[COOKIE_NAME] = token
    cookie[COOKIE_NAME]["path"] = "/"
    cookie[COOKIE_NAME]["httponly"] = True
    cookie[COOKIE_NAME]["samesite"] = "Lax"
    cookie[COOKIE_NAME]["max-age"] = str(max_age)
    if secure:
        cookie[COOKIE_NAME]["secure"] = True
    return cookie[COOKIE_NAME].OutputString()


def clear_session_cookie(secure: bool) -> str:
    return session_cookie("", secure, 0)
