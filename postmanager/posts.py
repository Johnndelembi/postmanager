"""Drafts, posting slots, and approval of TikTok-ready content."""

import os
from datetime import datetime, timezone
from .accounts import access_token
from .db import connect
from .planner import DEFAULT_QUEUE_TIMES, LOCAL_TIMEZONE, next_queue_time, parse_scheduled_at, validate_queue_times
from . import tiktok


EDITABLE = ("draft", "failed")
PRIVACY_LEVELS = tiktok.PRIVACY_LEVELS
POST_FIELDS = ("title", "caption", "media_asset_id", "duration_seconds", "privacy_level", "allow_comment", "allow_duet", "allow_stitch", "is_aigc", "brand_organic_toggle", "brand_content_toggle")


class PostError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _fields(payload: dict) -> dict:
    values = {}
    for key in POST_FIELDS:
        if key not in payload:
            continue
        value = payload[key]
        if key == "title":
            if not isinstance(value, str) or len(value) > 200:
                raise PostError(400, "Title must be 200 characters or fewer.")
            values[key] = value.strip()
        elif key == "caption":
            try:
                length = len(value.encode("utf-16-le")) // 2 if isinstance(value, str) else 2201
            except UnicodeEncodeError:
                length = 2201
            if length > 2200:
                raise PostError(400, "Caption is too long for TikTok.")
            values[key] = value.strip()
        elif key == "media_asset_id":
            if value in (None, ""):
                values[key] = None
            elif isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise PostError(400, "Choose an uploaded video.")
            else:
                values[key] = value
        elif key == "duration_seconds":
            if value in (None, ""):
                values[key] = None
            elif isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 36000:
                raise PostError(400, "Video duration must be a positive number of seconds.")
            else:
                values[key] = value
        elif key == "privacy_level":
            if value in (None, ""):
                values[key] = None
            elif value not in PRIVACY_LEVELS:
                raise PostError(400, "Choose a valid TikTok privacy setting.")
            else:
                values[key] = value
        else:
            if not isinstance(value, bool):
                raise PostError(400, f"{key} must be true or false.")
            values[key] = value
    return values


def _check_media_owner(db, user_id: int, asset_id: int | None) -> None:
    if asset_id is None:
        return
    row = db.execute("SELECT 1 FROM media_assets WHERE id = %s AND user_id = %s", (asset_id, user_id)).fetchone()
    if not row:
        raise PostError(400, "Choose a video uploaded to your account.")


def _public_post(row: dict) -> dict:
    return {**row, "preview_url": f"/api/media/{row['media_asset_id']}/preview" if row["media_asset_id"] else None}


def _owned_post(db, user_id: int, post_id: int, *, lock: bool = False) -> dict:
    clause = " FOR UPDATE" if lock else ""
    row = db.execute("SELECT * FROM posts WHERE id = %s AND user_id = %s" + clause, (post_id, user_id)).fetchone()
    if not row:
        raise PostError(404, "Post not found.")
    return row


def list_posts(user_id: int) -> list[dict]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM posts WHERE user_id = %s ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC",
            (user_id,),
        ).fetchall()
    return [_public_post(row) for row in rows]


def create_post(user_id: int, payload: dict) -> dict:
    values = _fields(payload)
    with connect() as db:
        _check_media_owner(db, user_id, values.get("media_asset_id"))
        row = db.execute(
            """INSERT INTO posts
               (user_id, title, caption, media_asset_id, duration_seconds, privacy_level,
                allow_comment, allow_duet, allow_stitch, is_aigc, brand_organic_toggle, brand_content_toggle)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
            (user_id, values.get("title", ""), values.get("caption", ""), values.get("media_asset_id"),
             values.get("duration_seconds"), values.get("privacy_level"), values.get("allow_comment", False),
             values.get("allow_duet", False), values.get("allow_stitch", False), values.get("is_aigc", False),
             values.get("brand_organic_toggle", False), values.get("brand_content_toggle", False)),
        ).fetchone()
    return _public_post(row)


def update_post(user_id: int, post_id: int, payload: dict) -> dict:
    values = _fields(payload)
    if not values:
        raise PostError(400, "No post fields were provided.")
    with connect() as db:
        current = _owned_post(db, user_id, post_id, lock=True)
        if current["status"] not in EDITABLE:
            raise PostError(409, "Move this post back to drafts before editing it.")
        if "media_asset_id" in values:
            _check_media_owner(db, user_id, values["media_asset_id"])
        assignments = ", ".join(f"{key} = %s" for key in values)
        row = db.execute(
            f"UPDATE posts SET {assignments}, updated_at = now(), last_error = NULL WHERE id = %s RETURNING *",
            (*values.values(), post_id),
        ).fetchone()
    return _public_post(row)


def delete_post(user_id: int, post_id: int) -> None:
    with connect() as db:
        current = _owned_post(db, user_id, post_id, lock=True)
        if current["status"] in ("publishing", "published"):
            raise PostError(409, "A post already sent to TikTok cannot be deleted here.")
        db.execute("DELETE FROM posts WHERE id = %s", (post_id,))


def get_settings(user_id: int) -> dict:
    with connect() as db:
        row = db.execute("SELECT timezone, queue_times FROM user_settings WHERE user_id = %s", (user_id,)).fetchone()
    return row or {"timezone": LOCAL_TIMEZONE, "queue_times": DEFAULT_QUEUE_TIMES}


def put_settings(user_id: int, payload: dict) -> dict:
    queue_times = validate_queue_times(payload.get("queue_times"))
    with connect() as db:
        row = db.execute(
            """INSERT INTO user_settings(user_id, timezone, queue_times) VALUES (%s, %s, %s)
               ON CONFLICT(user_id) DO UPDATE SET queue_times = EXCLUDED.queue_times, updated_at = now()
               RETURNING timezone, queue_times""",
            (user_id, LOCAL_TIMEZONE, queue_times),
        ).fetchone()
    return row


def draft_post(user_id: int, post_id: int) -> dict:
    with connect() as db:
        current = _owned_post(db, user_id, post_id, lock=True)
        if current["status"] in ("publishing", "published"):
            raise PostError(409, "This post has already been sent to TikTok.")
        row = db.execute(
            """UPDATE posts SET status = 'draft', scheduled_at = NULL, approved_at = NULL,
               last_error = NULL, updated_at = now() WHERE id = %s RETURNING *""",
            (post_id,),
        ).fetchone()
    return _public_post(row)


def _ready(post: dict, creator: dict) -> None:
    if not post["media_asset_id"] or not post["duration_seconds"]:
        raise PostError(400, "Upload a video and confirm its duration before scheduling.")
    options = creator.get("privacy_level_options") or []
    if post["privacy_level"] not in options:
        raise PostError(400, "Choose a privacy setting available for this TikTok account.")
    if os.environ.get("TIKTOK_APP_AUDITED") != "1" and post["privacy_level"] != "SELF_ONLY":
        raise PostError(400, "Until the TikTok app passes audit, choose Only me privacy.")
    max_duration = creator.get("max_video_post_duration_sec")
    if max_duration and post["duration_seconds"] > int(max_duration):
        raise PostError(400, "This video is longer than the TikTok account allows.")
    if post["brand_content_toggle"] and post["privacy_level"] == "SELF_ONLY":
        raise PostError(400, "Branded content cannot use Only me privacy.")
    for field, disabled in (("allow_comment", "comment_disabled"), ("allow_duet", "duet_disabled"), ("allow_stitch", "stitch_disabled")):
        if post[field] and creator.get(disabled):
            raise PostError(400, "A selected TikTok interaction is unavailable for this account.")


def approve_and_plan(user_id: int, post_id: int, action: str, payload: dict) -> dict:
    if payload.get("approved") is not True:
        raise PostError(400, "Review the post and approve its settings first.")
    if action not in ("queue", "schedule", "publish"):
        raise PostError(404, "Unknown posting action.")
    token = access_token(user_id)
    creator = tiktok.creator_info(token)
    now = datetime.now(timezone.utc)
    with connect() as db:
        db.execute("SELECT id FROM users WHERE id = %s FOR UPDATE", (user_id,))
        post = _owned_post(db, user_id, post_id, lock=True)
        if post["status"] not in EDITABLE:
            raise PostError(409, "Move this post back to drafts before planning it again.")
        _ready(post, creator)
        if action == "queue":
            settings = db.execute("SELECT queue_times FROM user_settings WHERE user_id = %s", (user_id,)).fetchone()
            slots = settings["queue_times"] if settings else DEFAULT_QUEUE_TIMES
            reserved = db.execute(
                """SELECT scheduled_at FROM posts WHERE user_id = %s AND status IN ('queued', 'scheduled')
                   AND scheduled_at > %s""",
                (user_id, now),
            ).fetchall()
            scheduled_at = next_queue_time(now, slots, {item["scheduled_at"] for item in reserved})
            status = "queued"
        elif action == "schedule":
            scheduled_at = parse_scheduled_at(payload.get("scheduled_at"), now)
            taken = db.execute(
                """SELECT 1 FROM posts WHERE user_id = %s AND status IN ('queued', 'scheduled')
                   AND scheduled_at = %s LIMIT 1""",
                (user_id, scheduled_at),
            ).fetchone()
            if taken:
                raise PostError(409, "Another post already uses that time.")
            status = "scheduled"
        else:
            scheduled_at = now
            status = "queued"
        row = db.execute(
            """UPDATE posts SET status = %s, scheduled_at = %s, approved_at = %s,
               last_error = NULL, updated_at = now() WHERE id = %s RETURNING *""",
            (status, scheduled_at, now, post_id),
        ).fetchone()
    return _public_post(row)
