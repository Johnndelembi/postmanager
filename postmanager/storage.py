"""Private, branch-scoped Neon Object Storage for creator videos."""

from __future__ import annotations

import os
from pathlib import Path

from .config import load_env


BUCKET = "videos"


class StorageError(RuntimeError):
    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.message = message
        self.status = status


def configured() -> bool:
    load_env()
    return all(os.environ.get(name) for name in (
        "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"
    ))


def _client():
    load_env()
    if not configured():
        raise StorageError("Neon Object Storage credentials are not configured.")
    from boto3 import client
    from botocore.config import Config

    endpoint = os.environ["AWS_ENDPOINT_URL_S3"]
    if not endpoint.startswith("https://"):
        raise StorageError("Neon Object Storage needs an HTTPS endpoint.")
    return client(
        "s3",
        endpoint_url=endpoint,
        region_name=os.environ["AWS_REGION"],
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def upload_file(path: str | Path, key: str) -> None:
    try:
        file_path = Path(path)
        with file_path.open("rb") as source:
            _client().put_object(Bucket=BUCKET, Key=key, Body=source,
                                 ContentLength=file_path.stat().st_size, ContentType="video/mp4")
    except StorageError:
        raise
    except Exception as exc:
        raise StorageError("The video could not be saved. Try again.") from exc


def presigned_get(key: str, *, expires_in: int = 900) -> str:
    if not 1 <= expires_in <= 3600:
        raise ValueError("Preview expiry must be between one second and one hour.")
    try:
        return _client().generate_presigned_url(
            "get_object",
            Params={"Bucket": BUCKET, "Key": key, "ResponseContentDisposition": "inline"},
            ExpiresIn=expires_in,
        )
    except StorageError:
        raise
    except Exception as exc:
        raise StorageError("The video preview could not be opened. Try again.") from exc


def delete_file(key: str) -> None:
    try:
        _client().delete_object(Bucket=BUCKET, Key=key)
    except StorageError:
        raise
    except Exception as exc:
        raise StorageError("The video could not be removed from storage.") from exc
