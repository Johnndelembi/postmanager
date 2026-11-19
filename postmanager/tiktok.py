"""Small server-side client for TikTok Login Kit, Direct Post, and Display API."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


API_BASE = "https://open.tiktokapis.com"
AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/"
SCOPES = "user.info.basic,video.publish,video.list"
PRIVACY_LEVELS = {
    "PUBLIC_TO_EVERYONE",
    "MUTUAL_FOLLOW_FRIENDS",
    "FOLLOWER_OF_CREATOR",
    "SELF_ONLY",
}
VIDEO_FIELDS = "id,create_time,share_url,title,like_count,comment_count,share_count,view_count,is_aigc"


class TikTokError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 502):
        super().__init__(message)
        self.code = code
        self.status = status


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise TikTokError("not_configured", f"{name} is not configured.", 503)
    return value


def _error_status(code: str, http_status: int) -> int:
    if http_status >= 400:
        return http_status
    if code in {"access_token_invalid", "invalid_grant"}:
        return 401
    if code in {"scope_not_authorized", "unauthorized_client"}:
        return 403
    if code in {"rate_limit_exceeded", "spam_risk_too_many_posts", "reached_active_user_cap"}:
        return 429
    if code in {"invalid_param", "privacy_level_option_mismatch", "invalid_request"}:
        return 400
    return 502


def _response(request: Request) -> dict:
    status = 200
    try:
        with urlopen(request, timeout=20) as response:
            status = response.status
            body = response.read(1_000_000)
    except HTTPError as error:
        status = error.code
        body = error.read(1_000_000)
    except (URLError, TimeoutError) as error:
        raise TikTokError("network_error", "TikTok could not be reached right now.", 503) from error

    try:
        result = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise TikTokError("invalid_response", "TikTok returned an unreadable response.") from error
    if not isinstance(result, dict):
        raise TikTokError("invalid_response", "TikTok returned an unexpected response.")

    api_error = result.get("error")
    if isinstance(api_error, dict):
        code = api_error.get("code")
        if code and code != "ok":
            raise TikTokError(str(code), str(api_error.get("message") or "TikTok rejected the request."), _error_status(str(code), status))
    elif isinstance(api_error, str) and api_error:
        raise TikTokError(api_error, str(result.get("error_description") or "TikTok rejected the request."), _error_status(api_error, status))
    if status >= 400:
        raise TikTokError("http_error", "TikTok rejected the request.", status)
    return result


def _form(path: str, values: dict[str, str]) -> dict:
    body = urlencode(values).encode("utf-8")
    request = Request(
        API_BASE + path,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache"},
        method="POST",
    )
    return _response(request)


def _api(path: str, access_token: str, *, payload: dict | None = None, method: str = "POST") -> dict:
    if not access_token:
        raise TikTokError("missing_token", "Connect a TikTok account first.", 401)
    request = Request(
        API_BASE + path,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
        },
        method=method,
    )
    result = _response(request)
    data = result.get("data")
    if not isinstance(data, dict):
        raise TikTokError("invalid_response", "TikTok returned no data.")
    return data


def _valid_redirect(uri: str) -> bool:
    if not isinstance(uri, str):
        return False
    try:
        parsed = urlsplit(uri)
        return parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    except ValueError:
        return False


def authorization_url(state: str, redirect_uri: str) -> str:
    if not state or not _valid_redirect(redirect_uri):
        raise TikTokError("invalid_oauth_request", "A state and registered HTTPS redirect URL are required.", 400)
    return AUTHORIZE_URL + "?" + urlencode({
        "client_key": _required_env("TIKTOK_CLIENT_KEY"),
        "response_type": "code",
        "scope": SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
    })


def exchange_code(code: str, redirect_uri: str) -> dict:
    if not code or not _valid_redirect(redirect_uri):
        raise TikTokError("invalid_oauth_request", "A code and registered HTTPS redirect URL are required.", 400)
    return _form("/v2/oauth/token/", {
        "client_key": _required_env("TIKTOK_CLIENT_KEY"),
        "client_secret": _required_env("TIKTOK_CLIENT_SECRET"),
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    })


def refresh_token(token: str) -> dict:
    if not token:
        raise TikTokError("missing_refresh_token", "Reconnect the TikTok account.", 401)
    # TikTok rotates refresh tokens; the caller must save the entire new response.
    return _form("/v2/oauth/token/", {
        "client_key": _required_env("TIKTOK_CLIENT_KEY"),
        "client_secret": _required_env("TIKTOK_CLIENT_SECRET"),
        "grant_type": "refresh_token",
        "refresh_token": token,
    })


def user_info(access_token: str) -> dict:
    data = _api("/v2/user/info/?fields=open_id,display_name,avatar_url", access_token, method="GET")
    user = data.get("user")
    if not isinstance(user, dict):
        raise TikTokError("invalid_response", "TikTok returned no user profile.")
    return user


def creator_info(access_token: str) -> dict:
    return _api("/v2/post/publish/creator_info/query/", access_token)


def direct_post_video(
    access_token: str,
    *,
    video_url: str,
    caption: str,
    privacy_level: str,
    is_aigc: bool = False,
    allow_comment: bool = True,
    allow_duet: bool = True,
    allow_stitch: bool = True,
    brand_organic_toggle: bool = False,
    brand_content_toggle: bool = False,
) -> dict:
    try:
        parsed = urlsplit(video_url)
    except (TypeError, ValueError) as error:
        raise TikTokError("invalid_video_url", "The video needs a public HTTPS URL on a TikTok-verified domain.", 400) from error
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise TikTokError("invalid_video_url", "The video needs a public HTTPS URL on a TikTok-verified domain.", 400)
    if privacy_level not in PRIVACY_LEVELS:
        raise TikTokError("invalid_privacy", "Choose an available TikTok privacy setting.", 400)
    if brand_content_toggle and privacy_level == "SELF_ONLY":
        raise TikTokError("invalid_privacy", "TikTok branded content cannot be private.", 400)
    try:
        caption_length = len(caption.encode("utf-16-le")) // 2 if isinstance(caption, str) else 2201
    except UnicodeEncodeError:
        caption_length = 2201
    if caption_length > 2200:
        raise TikTokError("invalid_caption", "The caption is too long for TikTok.", 400)
    return _api("/v2/post/publish/video/init/", access_token, payload={
        "post_info": {
            "title": caption,
            "privacy_level": privacy_level,
            "disable_comment": not allow_comment,
            "disable_duet": not allow_duet,
            "disable_stitch": not allow_stitch,
            "is_aigc": is_aigc,
            "brand_organic_toggle": brand_organic_toggle,
            "brand_content_toggle": brand_content_toggle,
        },
        "source_info": {"source": "PULL_FROM_URL", "video_url": video_url},
    })


def publish_status(access_token: str, publish_id: str) -> dict:
    if not publish_id:
        raise TikTokError("missing_publish_id", "The TikTok publish ID is missing.", 400)
    return _api("/v2/post/publish/status/fetch/", access_token, payload={"publish_id": publish_id})


def query_videos(access_token: str, video_ids: list[str]) -> list[dict]:
    if not video_ids:
        return []
    if len(video_ids) > 20:
        raise TikTokError("too_many_video_ids", "Query up to 20 TikTok videos at a time.", 400)
    data = _api(
        "/v2/video/query/?fields=" + VIDEO_FIELDS,
        access_token,
        payload={"filters": {"video_ids": [str(video_id) for video_id in video_ids]}},
    )
    videos = data.get("videos")
    if not isinstance(videos, list):
        raise TikTokError("invalid_response", "TikTok returned no video list.")
    return videos
