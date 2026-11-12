"""Schedule model for Slot Thermostat.

A schedule is plain JSON so it can be stored, sent over the websocket API and
edited by the card:

    {
      "mode": "daily" | "weekly",
      "daily":  [slot, ...],                  # used every day in daily mode
      "weekly": {"mon": [slot, ...], ...}     # used in weekly mode
    }

    slot = {"title": "Leaving home", "start": "07:00", "end": "10:00", "temp": 21.0}

Rules:
- ``end`` before ``start`` means the slot runs past midnight into the next day.
  ``end`` "24:00" (also written "23:59") means "until midnight"; 00:00–24:00 is all day.
  ``end`` "00:00" also ends at midnight (it runs "past" midnight by zero minutes).
- Seconds ("07:00:00") are accepted and ignored.
- Slots may not overlap, including across midnight and from Sunday into Monday.
- Time not covered by any slot is a gap: the thermostat does not heat.

Everything here is pure Python (no Home Assistant imports) so it is easy to test.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import re
from typing import Any

DAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MODES: tuple[str, ...] = ("daily", "weekly")
DAY_MINUTES = 1440
WEEK_MINUTES = 7 * DAY_MINUTES
MAX_SLOTS_PER_DAY = 24
MAX_TITLE_LENGTH = 60

_TIME_RE = re.compile(r"^([01]?\d|2[0-4]):([0-5]\d)(?::[0-5]\d)?$")


class ScheduleError(ValueError):
    """Raised when a schedule is invalid. The message is shown to the user."""


def parse_time(value: Any, *, allow_24: bool = False) -> int:
    """Parse "HH:MM" (or "HH:MM:SS", seconds ignored) into minutes since midnight."""
    match = _TIME_RE.match(str(value).strip()) if value is not None else None
    if not match:
        raise ScheduleError(f"Invalid time {value!r}, use HH:MM")
    minutes = int(match[1]) * 60 + int(match[2])
    if minutes > DAY_MINUTES or (minutes == DAY_MINUTES and not allow_24):
        raise ScheduleError(f"Invalid time {value!r}, use HH:MM")
    return minutes


def format_time(minutes: int) -> str:
    """Format minutes since midnight as "HH:MM" (1440 = "24:00", end of day)."""
    if minutes == DAY_MINUTES:
        return "24:00"
    minutes %= DAY_MINUTES
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def empty_schedule() -> dict[str, Any]:
    """Return a schedule with no slots."""
    return {"mode": "daily", "daily": [], "weekly": {day: [] for day in DAYS}}


def _slot_label(slot: dict[str, Any]) -> str:
    return slot["title"] or f"{slot['start']}–{slot['end']}"


def _normalize_slot(raw: Any, min_temp: float, max_temp: float) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ScheduleError("Each slot must be an object")
    title = str(raw.get("title") or "").strip()[:MAX_TITLE_LENGTH]
    start = parse_time(raw.get("start"))
    end = parse_time(raw.get("end"), allow_24=True)
    if end == DAY_MINUTES - 1:  # 23:59 / 23:59:59 means "until midnight"
        end = DAY_MINUTES
    label = title or format_time(start)
    if start == end:
        raise ScheduleError(f"Slot '{label}' starts and ends at the same time")
    try:
        temp = float(raw.get("temp"))
    except (TypeError, ValueError) as err:
        raise ScheduleError(f"Slot '{label}' needs a temperature") from err
    if not min_temp <= temp <= max_temp:
        raise ScheduleError(
            f"Slot '{label}': {temp:g}° is outside {min_temp:g}–{max_temp:g}°"
        )
    return {
        "title": title,
        "start": format_time(start),
        "end": format_time(end),
        "temp": round(temp, 2),
    }


def _normalize_list(raw: Any, min_temp: float, max_temp: float) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ScheduleError("Slots must be a list")
    if len(raw) > MAX_SLOTS_PER_DAY:
        raise ScheduleError(f"At most {MAX_SLOTS_PER_DAY} slots per day")
    slots = [_normalize_slot(item, min_temp, max_temp) for item in raw]
    slots.sort(key=lambda slot: parse_time(slot["start"]))
    return slots


def normalize_schedule(
    raw: Any, min_temp: float = 0.0, max_temp: float = 100.0
) -> dict[str, Any]:
    """Validate and normalize a schedule. Raises ScheduleError."""
    if not isinstance(raw, dict):
        raise ScheduleError("Schedule must be an object")
    mode = raw.get("mode", "daily")
    if mode not in MODES:
        raise ScheduleError(f"Mode must be one of {', '.join(MODES)}")
    weekly_raw = raw.get("weekly") or {}
    if not isinstance(weekly_raw, dict):
        raise ScheduleError("'weekly' must be an object with mon…sun")
    schedule = {
        "mode": mode,
        "daily": _normalize_list(raw.get("daily"), min_temp, max_temp),
        "weekly": {
            day: _normalize_list(weekly_raw.get(day), min_temp, max_temp) for day in DAYS
        },
    }
    for check_mode in MODES:
        _check_overlaps(schedule, check_mode)
    return schedule


@dataclass(frozen=True, slots=True)
class Interval:
    """A slot placed on the week, in minutes since Monday 00:00 (end may pass a week)."""

    start: int
    end: int
    slot: dict[str, Any]


def _day_slots(schedule: dict[str, Any], mode: str, day_index: int) -> list[dict[str, Any]]:
    if mode == "daily":
        return schedule["daily"]
    return schedule["weekly"][DAYS[day_index]]


def week_intervals(schedule: dict[str, Any], mode: str | None = None) -> list[Interval]:
    """All slots of the week as intervals, sorted by start."""
    mode = mode or schedule["mode"]
    intervals: list[Interval] = []
    for day_index in range(7):
        base = day_index * DAY_MINUTES
        for slot in _day_slots(schedule, mode, day_index):
            start = parse_time(slot["start"])
            end = parse_time(slot["end"], allow_24=True)
            if end <= start:
                end += DAY_MINUTES
            intervals.append(Interval(base + start, base + end, slot))
    intervals.sort(key=lambda interval: interval.start)
    return intervals


def _check_overlaps(schedule: dict[str, Any], mode: str) -> None:
    intervals = week_intervals(schedule, mode)
    if not intervals:
        return
    # Repeat the week once so Sunday-into-Monday overlaps are caught too.
    extended = intervals + [
        Interval(i.start + WEEK_MINUTES, i.end + WEEK_MINUTES, i.slot) for i in intervals
    ]
    for first, second in zip(extended, extended[1:]):
        if second.start < first.end:
            where = "" if mode == "daily" else f" on {DAYS[(second.start // DAY_MINUTES) % 7]}"
            raise ScheduleError(
                f"'{_slot_label(first.slot)}' overlaps '{_slot_label(second.slot)}'{where}"
            )


def _week_start(now: datetime) -> datetime:
    return (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def _week_minute(now: datetime) -> float:
    return (
        now.weekday() * DAY_MINUTES
        + now.hour * 60
        + now.minute
        + now.second / 60
        + now.microsecond / 60_000_000
    )


@dataclass(frozen=True, slots=True)
class ActiveSlot:
    """A slot resolved to real start and end times."""

    slot: dict[str, Any]
    start: datetime
    end: datetime


def _to_datetime(week_start: datetime, minutes: int) -> datetime:
    # Wall-clock arithmetic: 07:00 stays 07:00 across DST changes.
    return week_start + timedelta(minutes=minutes)


def active_slot(schedule: dict[str, Any], now: datetime) -> ActiveSlot | None:
    """The slot covering ``now``, or None in a gap."""
    minute = _week_minute(now)
    week_start = _week_start(now)
    for interval in week_intervals(schedule):
        # shift -1 week: a Sunday slot running past midnight into Monday
        for shift in (-WEEK_MINUTES, 0):
            start, end = interval.start + shift, interval.end + shift
            if start <= minute < end:
                return ActiveSlot(
                    interval.slot,
                    _to_datetime(week_start, start),
                    _to_datetime(week_start, end),
                )
    return None


def next_slot(schedule: dict[str, Any], now: datetime) -> ActiveSlot | None:
    """The next slot that starts after ``now``."""
    minute = _week_minute(now)
    week_start = _week_start(now)
    best: tuple[int, Interval] | None = None
    for interval in week_intervals(schedule):
        for shift in (0, WEEK_MINUTES):
            start = interval.start + shift
            if start > minute and (best is None or start < best[0]):
                best = (start, interval)
    if best is None:
        return None
    start, interval = best
    return ActiveSlot(
        interval.slot,
        _to_datetime(week_start, start),
        _to_datetime(week_start, start + interval.end - interval.start),
    )


def next_change(schedule: dict[str, Any], now: datetime) -> datetime | None:
    """The next moment a slot starts or ends after ``now``."""
    minute = _week_minute(now)
    candidates = [
        boundary + shift
        for interval in week_intervals(schedule)
        for boundary in (interval.start, interval.end)
        for shift in (-WEEK_MINUTES, 0, WEEK_MINUTES)
        if boundary + shift > minute
    ]
    if not candidates:
        return None
    return _to_datetime(_week_start(now), min(candidates))
