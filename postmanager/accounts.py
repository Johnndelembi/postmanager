"""TikTok account credentials, encrypted before they reach Postgres."""

from datetime import datetime, timedelta, timezone

from .config import required_env
from .db import connect
from . import tiktok


def _cipher():
    try:
        from cryptography.fernet import Fernet
    except ImportError as exc:
        raise RuntimeError("Install Python dependencies from requirements.txt") from exc
    return Fernet(required_env("TOKEN_ENCRYPTION_KEY").encode("ascii"))


def account_status(user_id: int) -> dict:
    with connect() as db:
        row = db.execute("SELECT username FROM tiktok_accounts WHERE user_id = %s", (user_id,)).fetchone()
    return {"connected": bool(row), "username": row["username"] if row else None}


def save_account(user_id: int, tokens: dict, profile: dict) -> None:
    cipher = _cipher()
    now = datetime.now(timezone.utc)
    user = profile.get("user", profile)
    open_id = tokens.get("open_id") or user.get("open_id")
    if not open_id or not tokens.get("access_token") or not tokens.get("refresh_token"):
        raise ValueError("TikTok did not return complete account credentials.")
    access_expiry = now + timedelta(seconds=int(tokens.get("expires_in", 86400)))
    refresh_expiry = now + timedelta(seconds=int(tokens.get("refresh_expires_in", 31536000)))
    access_ciphertext = cipher.encrypt(tokens["access_token"].encode()).decode()
    refresh_ciphertext = cipher.encrypt(tokens["refresh_token"].encode()).decode()
    username = user.get("display_name") or user.get("username") or None
    with connect() as db:
        db.execute(
            """INSERT INTO tiktok_accounts
                 (user_id, open_id, username, access_token_ciphertext, refresh_token_ciphertext,
                  access_expires_at, refresh_expires_at)
                 VALUES (%s, %s, %s, %s, %s, %s, %s)
                 ON CONFLICT (user_id) DO UPDATE SET
                   open_id = EXCLUDED.open_id, username = EXCLUDED.username,
                   access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                   refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
                   access_expires_at = EXCLUDED.access_expires_at,
                   refresh_expires_at = EXCLUDED.refresh_expires_at,
                   updated_at = now()""",
            (user_id, open_id, username, access_ciphertext, refresh_ciphertext, access_expiry, refresh_expiry),
        )


def access_token(user_id: int) -> str:
    cipher = _cipher()
    now = datetime.now(timezone.utc)
    with connect() as db:
        row = db.execute("SELECT * FROM tiktok_accounts WHERE user_id = %s FOR UPDATE", (user_id,)).fetchone()
        if not row:
            raise ValueError("Connect a TikTok account first.")
        if row["access_expires_at"] > now + timedelta(minutes=2):
            return cipher.decrypt(row["access_token_ciphertext"].encode()).decode()
        if row["refresh_expires_at"] <= now:
            raise ValueError("TikTok authorization expired. Reconnect the account.")
        tokens = tiktok.refresh_token(cipher.decrypt(row["refresh_token_ciphertext"].encode()).decode())
        access = tokens.get("access_token")
        refresh = tokens.get("refresh_token")
        if not access or not refresh:
            raise ValueError("TikTok did not return refreshed credentials.")
        db.execute(
            """UPDATE tiktok_accounts SET access_token_ciphertext = %s, refresh_token_ciphertext = %s,
                 access_expires_at = %s, refresh_expires_at = %s, updated_at = now() WHERE user_id = %s""",
            (
                cipher.encrypt(access.encode()).decode(),
                cipher.encrypt(refresh.encode()).decode(),
                now + timedelta(seconds=int(tokens.get("expires_in", 86400))),
                now + timedelta(seconds=int(tokens.get("refresh_expires_in", 31536000))),
                user_id,
            ),
        )
        return access
