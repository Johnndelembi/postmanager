"""Neon Postgres connection helper."""

from .config import required_env


def connect():
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError("Install Python dependencies from requirements.txt") from exc
    return psycopg.connect(required_env("DATABASE_URL"), row_factory=dict_row, connect_timeout=10)
