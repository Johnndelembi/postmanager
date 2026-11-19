"""Send due posts to TikTok and refresh publishing status and basic metrics."""

from __future__ import annotations

import argparse
import logging
import os
import time
from urllib.parse import quote, urlsplit

from . import tiktok
from .accounts import access_token
from .db import connect
from .config import load_env
from .posts import PostError, _ready


def media_url_prefix() -> str | None:
    """Publishing stays paused until an owned, TikTok-verified media route exists."""
    load_env()
    prefix = os.environ.get("TIKTOK_MEDIA_URL_PREFIX", "").strip()
    if not prefix:
        return None
    try:
        parsed = urlsplit(prefix)
    except ValueError:
        return None
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    return prefix.rstrip("/") + "/"


def _media_url(key: str) -> str:
    prefix = media_url_prefix()
    if not prefix:
        raise PostError(503, "TikTok publishing needs a verified media URL prefix.")
    if not key:
        raise PostError(400, "This post has no uploaded video.")
    return prefix + quote(key, safe="/")


def _fail(post_id: int, message: str) -> None:
    with connect() as db:
        db.execute(
            "UPDATE posts SET status = 'failed', last_error = %s, updated_at = now() WHERE id = %s",
            (message[:500], post_id),
        )


def recover_stale_claims() -> int:
    with connect() as db:
        rows = db.execute(
            """UPDATE posts SET status = 'failed',
               last_error = 'Publishing outcome is uncertain. Check TikTok before retrying.', updated_at = now()
               WHERE status = 'publishing' AND tiktok_publish_id IS NULL
                 AND updated_at < now() - interval '10 minutes' RETURNING id"""
        ).fetchall()
    return len(rows)


def expire_overdue() -> int:
    """Do not publish old queued posts in a burst when delivery is enabled later."""
    if media_url_prefix() is None:
        return 0
    with connect() as db:
        rows = db.execute(
            """UPDATE posts SET status = 'failed',
               last_error = 'The planned time passed while publishing was unavailable. Review and reschedule.',
               updated_at = now()
               WHERE status IN ('queued', 'scheduled') AND approved_at IS NOT NULL
                 AND scheduled_at < now() - interval '30 minutes' RETURNING id"""
        ).fetchall()
    return len(rows)


def publish_one(post_id: int | None = None) -> bool:
    if media_url_prefix() is None:
        return False
    with connect() as db:
        if post_id is None:
            post = db.execute(
                """SELECT p.*, m.storage_key FROM posts p
                   LEFT JOIN media_assets m ON m.id = p.media_asset_id
                   WHERE p.status IN ('queued', 'scheduled') AND p.scheduled_at <= now()
                   AND p.approved_at IS NOT NULL ORDER BY p.scheduled_at, p.id
                   LIMIT 1 FOR UPDATE OF p SKIP LOCKED"""
            ).fetchone()
        else:
            post = db.execute(
                """SELECT p.*, m.storage_key FROM posts p
                   LEFT JOIN media_assets m ON m.id = p.media_asset_id
                   WHERE p.id = %s AND p.status IN ('queued', 'scheduled')
                   AND p.scheduled_at <= now() AND p.approved_at IS NOT NULL
                   FOR UPDATE OF p SKIP LOCKED""",
                (post_id,),
            ).fetchone()
        if not post:
            return False
        db.execute("UPDATE posts SET status = 'publishing', updated_at = now() WHERE id = %s", (post["id"],))
    try:
        token = access_token(post["user_id"])
        creator = tiktok.creator_info(token)
        _ready(post, creator)
        response = tiktok.direct_post_video(
            token,
            video_url=_media_url(post["storage_key"]),
            caption=post["caption"],
            privacy_level=post["privacy_level"],
            is_aigc=post["is_aigc"],
            allow_comment=post["allow_comment"],
            allow_duet=post["allow_duet"],
            allow_stitch=post["allow_stitch"],
            brand_organic_toggle=post["brand_organic_toggle"],
            brand_content_toggle=post["brand_content_toggle"],
        )
        publish_id = response.get("publish_id")
        if not publish_id:
            raise tiktok.TikTokError("missing_publish_id", "TikTok did not return a publish ID.")
        with connect() as db:
            db.execute(
                "UPDATE posts SET tiktok_publish_id = %s, last_error = NULL, updated_at = now() WHERE id = %s",
                (publish_id, post["id"]),
            )
    except (tiktok.TikTokError, PostError, ValueError, RuntimeError) as exc:
        _fail(post["id"], str(exc) + " Check TikTok before retrying if the upload may have reached it.")
    return True


def refresh_publishing(limit: int = 20) -> int:
    with connect() as db:
        pending = db.execute(
            """SELECT id, user_id, tiktok_publish_id FROM posts
               WHERE tiktok_publish_id IS NOT NULL AND
                 (status = 'publishing' OR (status = 'published' AND tiktok_post_id IS NULL
                    AND updated_at < now() - interval '6 hours'))
               ORDER BY updated_at LIMIT %s""",
            (limit,),
        ).fetchall()
    refreshed = 0
    for post in pending:
        try:
            status = tiktok.publish_status(access_token(post["user_id"]), post["tiktok_publish_id"])
            post_ids = status.get("publicaly_available_post_id") or []
            if status.get("status") == "PUBLISH_COMPLETE":
                with connect() as db:
                    db.execute(
                        """UPDATE posts SET status = 'published', published_at = COALESCE(published_at, now()),
                           tiktok_post_id = COALESCE(%s, tiktok_post_id), last_error = NULL, updated_at = now()
                           WHERE id = %s""",
                        (str(post_ids[0]) if post_ids else None, post["id"]),
                    )
                refreshed += 1
            elif status.get("status") == "FAILED":
                _fail(post["id"], "TikTok rejected the post: " + str(status.get("fail_reason") or "unknown reason"))
                refreshed += 1
        except (tiktok.TikTokError, ValueError, RuntimeError):
            logging.exception("Could not refresh TikTok status for post %s", post["id"])
    return refreshed


def refresh_metrics(limit: int = 20) -> int:
    with connect() as db:
        due = db.execute(
            """SELECT id, user_id, tiktok_post_id FROM posts
               WHERE status = 'published' AND tiktok_post_id IS NOT NULL AND
                 (analytics_synced_at IS NULL OR analytics_synced_at < now() - interval '6 hours')
               ORDER BY analytics_synced_at NULLS FIRST LIMIT %s""",
            (limit,),
        ).fetchall()
    refreshed = 0
    for post in due:
        try:
            videos = tiktok.query_videos(access_token(post["user_id"]), [post["tiktok_post_id"]])
            if not videos:
                with connect() as db:
                    db.execute("UPDATE posts SET analytics_synced_at = now() WHERE id = %s", (post["id"],))
                continue
            video = videos[0]
            raw_counts = tuple(video.get(key) for key in ("view_count", "like_count", "comment_count", "share_count"))
            if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in raw_counts):
                with connect() as db:
                    db.execute("UPDATE posts SET analytics_synced_at = now() WHERE id = %s", (post["id"],))
                continue
            counts = raw_counts
            with connect() as db:
                db.execute(
                    """UPDATE posts SET view_count = %s, like_count = %s, comment_count = %s,
                       share_count = %s, analytics_synced_at = now(), updated_at = now() WHERE id = %s""",
                    (*counts, post["id"]),
                )
                db.execute(
                    """INSERT INTO post_metric_snapshots
                       (post_id, view_count, like_count, comment_count, share_count)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (post["id"], *counts),
                )
            refreshed += 1
        except (tiktok.TikTokError, ValueError, RuntimeError):
            logging.exception("Could not refresh TikTok metrics for post %s", post["id"])
    return refreshed


def run_once() -> dict:
    recovered = recover_stale_claims()
    expired = expire_overdue()
    published = 0
    for _ in range(20):
        if not publish_one():
            break
        published += 1
    return {"sent": published, "recovered": recovered, "expired": expired,
            "publishing_paused": media_url_prefix() is None,
            "status_updates": refresh_publishing(), "metric_updates": refresh_metrics()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Process due TikTok posts and update metrics.")
    parser.add_argument("--loop", action="store_true", help="Run every minute for local development.")
    args = parser.parse_args()
    while True:
        print(run_once())
        if not args.loop:
            return
        time.sleep(60)


if __name__ == "__main__":
    main()
