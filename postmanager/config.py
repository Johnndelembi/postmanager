"""Read local environment settings without executing the .env file."""

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key and key.replace("_", "").isalnum():
            os.environ.setdefault(key, value.strip().strip('"\''))


def required_env(name: str) -> str:
    load_env()
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def base_url() -> str:
    load_env()
    return os.environ.get("APP_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
