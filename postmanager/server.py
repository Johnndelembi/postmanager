"""Development HTTP API and dashboard for the Python-first Postmanager MVP."""

from __future__ import annotations

import hmac
import hashlib
import http.cookies
import json
import logging
import os
import re
import secrets
import tempfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from . import auth, media, posts, storage, tiktok
from .accounts import access_token, account_status, save_account
from .config import ROOT, base_url, load_env, required_env


PUBLIC = ROOT / "public"
POST_PATH = re.compile(r"^/api/posts/(\d+)$")
POST_ACTION_PATH = re.compile(r"^/api/posts/(\d+)/(queue|schedule|publish|draft)$")
MEDIA_PREVIEW_PATH = re.compile(r"^/api/media/(\d+)/preview$")
OAUTH_COOKIE = "postmanager_tiktok_state"


class APIError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def _cookie(name: str, value: str, *, max_age: int) -> str:
    cookie = http.cookies.SimpleCookie()
    cookie[name] = value
    cookie[name]["path"] = "/"
    cookie[name]["httponly"] = True
    cookie[name]["samesite"] = "Lax"
    cookie[name]["max-age"] = str(max_age)
    if base_url().startswith("https://"):
        cookie[name]["secure"] = True
    return cookie[name].OutputString()


class Handler(BaseHTTPRequestHandler):
    server_version = "Postmanager/0.1"

    def log_request(self, code="-", size="-") -> None:
        # OAuth callbacks contain a one-time code in the query string.
        logging.info("%s %s %s", self.command, urlsplit(self.path).path, code)

    def _send(self, status: int, payload: dict, headers: list[tuple[str, str]] | None = None) -> None:
        body = json.dumps(payload, default=_json_default, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if getattr(self, "_renewed_session", None):
            self.send_header("Set-Cookie", self._renewed_session)
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str, headers: list[tuple[str, str]] | None = None) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "_renewed_session", None):
            self.send_header("Set-Cookie", self._renewed_session)
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()

    def _static(self, path: str) -> None:
        files = {"/": ("index.html", "text/html"), "/app.css": ("app.css", "text/css"), "/app.js": ("app.js", "text/javascript")}
        if path not in files:
            raise APIError(404, "Page not found.")
        name, content_type = files[path]
        data = (PUBLIC / name).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise APIError(415, "Send JSON with Content-Type: application/json.")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError as exc:
            raise APIError(411, "Content-Length is required.") from exc
        if not 0 <= length <= 1_000_000:
            raise APIError(413, "Request is too large.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError) as exc:
            raise APIError(400, "Request body must be valid JSON.") from exc
        if not isinstance(payload, dict):
            raise APIError(400, "Request body must be a JSON object.")
        return payload

    def _check_origin(self) -> None:
        expected = base_url()
        if self.headers.get("Origin") != expected:
            raise APIError(403, "Request origin is not allowed.")

    def _user(self) -> dict:
        cookie = http.cookies.SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except http.cookies.CookieError:
            raise APIError(401, "Sign in to continue.")
        token = cookie[auth.COOKIE_NAME].value if auth.COOKIE_NAME in cookie else None
        user_id = auth.read_session(token)
        if user_id is None:
            raise APIError(401, "Sign in to continue.")
        user = auth.get_user(user_id)
        if not user:
            raise APIError(401, "Sign in to continue.")
        self._renewed_session = auth.session_cookie(auth.make_session(user_id), base_url().startswith("https://"))
        return user

    def _tiktok_status(self, user_id: int) -> dict:
        configured = all(os.environ.get(key) for key in ("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY")) and base_url().startswith("https://")
        from .worker import media_url_prefix
        publishing_ready = bool(configured and media_url_prefix())
        return {**account_status(user_id), "configured": bool(configured), "publishing_ready": publishing_ready,
                "audited": os.environ.get("TIKTOK_APP_AUDITED") == "1"}

    def _connect_tiktok(self, user_id: int) -> None:
        if not self._tiktok_status(user_id)["configured"]:
            raise APIError(503, "Set TikTok credentials, token encryption key, and an HTTPS APP_BASE_URL first.")
        state = secrets.token_urlsafe(32)
        callback = base_url() + "/api/tiktok/callback"
        destination = tiktok.authorization_url(state, callback)
        marker = f"{user_id}.{state}"
        signature = hmac.new(required_env("SESSION_SECRET").encode(), marker.encode(), hashlib.sha256).hexdigest()
        self._redirect(destination, [("Set-Cookie", _cookie(OAUTH_COOKIE, marker + "." + signature, max_age=600))])

    def _tiktok_callback(self, user_id: int, query: dict[str, list[str]]) -> None:
        if query.get("error"):
            raise APIError(400, "TikTok authorization was cancelled or denied.")
        state = query.get("state", [""])[0]
        code = query.get("code", [""])[0]
        cookie = http.cookies.SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except http.cookies.CookieError as exc:
            raise APIError(400, "TikTok authorization state is invalid or expired.") from exc
        expected = cookie[OAUTH_COOKIE].value if OAUTH_COOKIE in cookie else ""
        parts = expected.split(".")
        if len(parts) != 3:
            raise APIError(400, "TikTok authorization state is invalid or expired.")
        marker = f"{parts[0]}.{parts[1]}"
        signature = hmac.new(required_env("SESSION_SECRET").encode(), marker.encode(), hashlib.sha256).hexdigest()
        if not state or not code or parts[0] != str(user_id) or not hmac.compare_digest(state, parts[1]) or not hmac.compare_digest(signature, parts[2]):
            raise APIError(400, "TikTok authorization state is invalid or expired.")
        tokens = tiktok.exchange_code(code, base_url() + "/api/tiktok/callback")
        scopes = set(str(tokens.get("scope", "")).split(","))
        if not {"user.info.basic", "video.publish", "video.list"}.issubset(scopes):
            raise APIError(403, "Authorize profile, publishing, and video access to connect TikTok.")
        profile = tiktok.user_info(tokens["access_token"])
        save_account(user_id, tokens, profile)
        self._redirect(base_url() + "/?tiktok=connected", [("Set-Cookie", _cookie(OAUTH_COOKIE, "", max_age=0))])

    def _get(self, path: str, query: dict[str, list[str]]) -> None:
        if path in ("/", "/app.css", "/app.js"):
            self._static(path)
            return
        if path == "/api/health":
            self._send(200, {"ok": True})
            return
        user = self._user()
        if path == "/api/media/status":
            self._send(200, {"configured": storage.configured()})
            return
        if match := MEDIA_PREVIEW_PATH.fullmatch(path):
            self._redirect(media.preview_url(user["id"], int(match.group(1))))
            return
        if path == "/api/me":
            self._send(200, user)
        elif path == "/api/settings":
            self._send(200, posts.get_settings(user["id"]))
        elif path == "/api/posts":
            self._send(200, {"posts": posts.list_posts(user["id"])})
        elif path == "/api/tiktok/status":
            self._send(200, self._tiktok_status(user["id"]))
        elif path == "/api/tiktok/creator-info":
            self._send(200, tiktok.creator_info(access_token(user["id"])))
        elif path == "/api/tiktok/connect":
            self._connect_tiktok(user["id"])
        elif path == "/api/tiktok/callback":
            self._tiktok_callback(user["id"], query)
        else:
            raise APIError(404, "Route not found.")

    def _post(self, path: str) -> None:
        self._check_origin()
        if path == "/api/auth/request-otp":
            data = self._read_json()
            self._send(200, auth.request_otp(data.get("phone"), self.client_address[0]))
            return
        if path == "/api/auth/verify-otp":
            data = self._read_json()
            user = auth.verify_otp(data.get("phone"), data.get("code"))
            cookie = auth.session_cookie(auth.make_session(user["id"]), base_url().startswith("https://"))
            self._send(200, user, [("Set-Cookie", cookie)])
            return
        user = self._user()
        if path == "/api/media":
            self._upload_media(user["id"])
            return
        if path == "/api/logout":
            self._renewed_session = None
            self._send(200, {"ok": True}, [("Set-Cookie", auth.clear_session_cookie(base_url().startswith("https://")))])
            return
        data = self._read_json()
        if path == "/api/posts":
            self._send(201, posts.create_post(user["id"], data))
        elif path == "/api/settings":
            raise APIError(405, "Use PUT for settings.")
        elif (match := POST_ACTION_PATH.fullmatch(path)):
            post_id, action = int(match.group(1)), match.group(2)
            if action == "draft":
                self._send(200, posts.draft_post(user["id"], post_id))
                return
            if action == "publish" and not self._tiktok_status(user["id"])["publishing_ready"]:
                raise APIError(503, "Direct publishing needs TikTok credentials and a verified media URL prefix.")
            post = posts.approve_and_plan(user["id"], post_id, action, data)
            if action == "publish":
                from .worker import publish_one
                publish_one(post["id"])
                post = next(item for item in posts.list_posts(user["id"]) if item["id"] == post["id"])
            self._send(200, post)
        else:
            raise APIError(404, "Route not found.")

    def _upload_media(self, user_id: int) -> None:
        if not storage.configured():
            raise storage.StorageError("Neon Object Storage credentials are not configured.")
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "Send a video with Content-Length.")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError as exc:
            raise APIError(411, "Content-Length is required for video uploads.") from exc
        if not 0 < length <= media.MAX_VIDEO_BYTES:
            raise APIError(413, "MP4 videos must be 500 MB or smaller.")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "video/mp4":
            raise APIError(415, "Choose an MP4 video.")
        filename = unquote(self.headers.get("X-Filename", "video.mp4"))
        with tempfile.TemporaryDirectory(prefix="postmanager-upload-") as folder:
            path = Path(folder) / "upload.mp4"
            remaining = length
            with path.open("wb") as output:
                while remaining:
                    part = self.rfile.read(min(1024 * 1024, remaining))
                    if not part:
                        raise APIError(400, "The video upload ended early.")
                    output.write(part)
                    remaining -= len(part)
            with path.open("rb") as uploaded:
                if uploaded.read(12)[4:8] != b"ftyp":
                    raise APIError(415, "Choose an MP4 video.")
            asset = media.create_asset(user_id, path, filename, length)
        self._send(201, asset)

    def _patch(self, path: str) -> None:
        self._check_origin()
        user = self._user()
        match = POST_PATH.fullmatch(path)
        if not match:
            raise APIError(404, "Route not found.")
        self._send(200, posts.update_post(user["id"], int(match.group(1)), self._read_json()))

    def _put(self, path: str) -> None:
        self._check_origin()
        user = self._user()
        if path == "/api/settings":
            self._send(200, posts.put_settings(user["id"], self._read_json()))
        else:
            raise APIError(404, "Route not found.")

    def _delete(self, path: str) -> None:
        self._check_origin()
        user = self._user()
        match = POST_PATH.fullmatch(path)
        if not match:
            raise APIError(404, "Route not found.")
        posts.delete_post(user["id"], int(match.group(1)))
        self._send(200, {"ok": True})

    def _handle(self, method: str) -> None:
        load_env()
        self._renewed_session = None
        parsed = urlsplit(self.path)
        try:
            if method == "GET":
                self._get(parsed.path, parse_qs(parsed.query))
            elif method == "POST":
                self._post(parsed.path)
            elif method == "PATCH":
                self._patch(parsed.path)
            elif method == "PUT":
                self._put(parsed.path)
            elif method == "DELETE":
                self._delete(parsed.path)
            else:
                raise APIError(405, "Method not allowed.")
        except (APIError, auth.AuthError, posts.PostError, media.MediaError, storage.StorageError) as exc:
            headers = [("Retry-After", str(exc.retry_after))] if getattr(exc, "retry_after", None) else []
            self._send(exc.status, {"error": exc.message}, headers)
        except tiktok.TikTokError as exc:
            self._send(exc.status, {"error": str(exc), "code": exc.code})
        except ValueError as exc:
            self._send(400, {"error": str(exc)})
        except Exception:
            logging.exception("Unhandled request error")
            self._send(500, {"error": "The request could not be completed."})

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def do_PUT(self) -> None:
        self._handle("PUT")

    def do_DELETE(self) -> None:
        self._handle("DELETE")


def main() -> None:
    load_env()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Postmanager listening on {base_url()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
