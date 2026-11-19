"""Small, timezone-aware scheduling rules shared by API and worker."""

import re
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


LOCAL_TIMEZONE = "Africa/Dar_es_Salaam"
DEFAULT_QUEUE_TIMES = ["09:00", "18:00"]


def validate_queue_times(values: object) -> list[str]:
    if not isinstance(values, list) or not 1 <= len(values) <= 12:
        raise ValueError("Choose between one and twelve posting times.")
    result = []
    for value in values:
        if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("Posting times must use HH:MM in 24-hour format.")
        result.append(value)
    if len(set(result)) != len(result):
        raise ValueError("Posting times must be unique.")
    return sorted(result)


def next_queue_time(now: datetime, queue_times: list[str], reserved: set[datetime]) -> datetime:
    if now.tzinfo is None:
        raise ValueError("Current time must include a timezone.")
    local_zone = ZoneInfo(LOCAL_TIMEZONE)
    now_utc = now.astimezone(timezone.utc)
    local_day = now.astimezone(local_zone).date()
    occupied = {value.astimezone(timezone.utc) for value in reserved}
    slots = validate_queue_times(queue_times)
    for day_offset in range(366):
        day = local_day + timedelta(days=day_offset)
        for slot in slots:
            hour, minute = map(int, slot.split(":"))
            candidate = datetime.combine(day, time(hour, minute), local_zone).astimezone(timezone.utc)
            if candidate > now_utc and candidate not in occupied:
                return candidate
    raise ValueError("No queue slot is available in the next year.")


def parse_scheduled_at(value: object, now: datetime) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Choose a date and time.")
    try:
        scheduled = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Choose a valid date and time.") from exc
    if scheduled.tzinfo is None:
        raise ValueError("Scheduled time must include a timezone.")
    scheduled = scheduled.astimezone(timezone.utc)
    if scheduled <= now.astimezone(timezone.utc):
        raise ValueError("Scheduled time must be in the future.")
    return scheduled
