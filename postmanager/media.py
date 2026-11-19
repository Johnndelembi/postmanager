"""Video records stored alongside private Neon Object Storage objects."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from .db import connect
from . import storage


MAX_VIDEO_BYTES = 500 * 1024 * 1024


class MediaError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def create_asset(user_id: int, path: str | Path, filename: str, size: int) -> dict:
    if not 0 < size <= MAX_VIDEO_BYTES:
        raise MediaError(413, "MP4 videos must be 500 MB or smaller.")
    filename = filename.strip().split("/")[-1].split("\\")[-1][:255] or "video.mp4"
    if not filename.lower().endswith(".mp4"):
        raise MediaError(400, "Choose an MP4 video.")
    key = f"users/{user_id}/{uuid.uuid4().hex}.mp4"
    storage.upload_file(path, key)
    try:
        with connect() as db:
            row = db.execute(
                """INSERT INTO media_assets(user_id, storage_key, original_filename, content_type, size_bytes)
                   VALUES (%s, %s, %s, 'video/mp4', %s) RETURNING id, original_filename, size_bytes""",
                (user_id, key, filename, size),
            ).fetchone()
    except Exception:
        try:
            storage.delete_file(key)
        except storage.StorageError:
            logging.exception("Could not clean up unreferenced video object")
        raise
    return {**row, "preview_url": f"/api/media/{row['id']}/preview"}


def owned_asset(user_id: int, asset_id: int) -> dict:
    with connect() as db:
        row = db.execute(
            "SELECT id, user_id, storage_key, original_filename, size_bytes FROM media_assets WHERE id = %s AND user_id = %s",
            (asset_id, user_id),
        ).fetchone()
    if not row:
        raise MediaError(404, "Video not found.")
    return row


def preview_url(user_id: int, asset_id: int) -> str:
    return storage.presigned_get(owned_asset(user_id, asset_id)["storage_key"])
