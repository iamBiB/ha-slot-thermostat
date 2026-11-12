"""Tests for the pure schedule logic."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from custom_components.slot_thermostat.schedule import (
    ScheduleError,
    active_slot,
    next_change,
    next_slot,
    normalize_schedule,
)

TZ = ZoneInfo("Europe/Bucharest")


def at(day: int, hour: int, minute: int = 0) -> datetime:
    """Monday 2026-11-09 is day 0."""
    return datetime(2026, 11, 9 + day, hour, minute, tzinfo=TZ)


def slot(title, start, end, temp):
    return {"title": title, "start": start, "end": end, "temp": temp}


DAILY = normalize_schedule(
    {
        "mode": "daily",
        "daily": [
            slot("Returning", "10:00", "17:00", 22.5),
            slot("Leaving home", "07:00", "10:00", 21),
        ],
    }
)


def test_normalize_sorts_and_fills_week():
    assert [s["title"] for s in DAILY["daily"]] == ["Leaving home", "Returning"]
    assert set(DAILY["weekly"]) == {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}


def test_active_slot_and_gap():
    hit = active_slot(DAILY, at(2, 8, 30))
    assert hit.slot["title"] == "Leaving home"
    assert hit.end == at(2, 10)
    assert active_slot(DAILY, at(2, 10)).slot["title"] == "Returning"  # end is exclusive
    assert active_slot(DAILY, at(2, 18)) is None
    assert active_slot(DAILY, at(2, 6, 59)) is None


def test_next_change_and_next_slot():
    assert next_change(DAILY, at(2, 8)) == at(2, 10)
    assert next_change(DAILY, at(2, 18)) == at(3, 7)
    upcoming = next_slot(DAILY, at(2, 18))
    assert upcoming.slot["title"] == "Leaving home"
    assert upcoming.start == at(3, 7)


def test_past_midnight_and_sunday_into_monday():
    sched = normalize_schedule(
        {"mode": "weekly", "weekly": {"sun": [slot("Late", "22:00", "02:00", 19)]}}
    )
    assert active_slot(sched, at(6, 23)).slot["title"] == "Late"
    late = active_slot(sched, at(7, 1))  # Monday 01:00 of the next week
    assert late.slot["title"] == "Late"
    assert late.end == at(7, 2)
    assert active_slot(sched, at(7, 2)) is None


def test_until_midnight():
    sched = normalize_schedule({"daily": [slot("Evening", "18:00", "24:00", 21)]})
    assert sched["daily"][0]["end"] == "24:00"
    assert active_slot(sched, at(0, 23, 59)).slot["title"] == "Evening"
    assert active_slot(sched, at(1, 0, 0)) is None


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ({"daily": [slot("A", "07:00", "09:00", 21), slot("B", "08:00", "10:00", 21)]}, "overlaps"),
        ({"daily": [slot("A", "22:00", "08:00", 21), slot("B", "07:00", "09:00", 21)]}, "overlaps"),
        (
            {"mode": "weekly", "weekly": {"sun": [slot("A", "23:00", "02:00", 21)], "mon": [slot("B", "01:00", "03:00", 21)]}},
            "overlaps",
        ),
        ({"daily": [slot("A", "07:00", "07:00", 21)]}, "same time"),
        ({"daily": [slot("A", "7am", "09:00", 21)]}, "Invalid time"),
        ({"daily": [slot("A", "07:00", "09:00", 80)]}, "outside"),
        ({"daily": [slot("A", "07:00", "09:00", None)]}, "temperature"),
        ({"mode": "monthly"}, "Mode"),
    ],
)
def test_invalid(raw, message):
    with pytest.raises(ScheduleError, match=message):
        normalize_schedule(raw, 5, 30)


def test_seconds_and_end_of_day():
    sched = normalize_schedule({"daily": [slot("Day", "00:00:00", "23:59:59", 21)]})
    assert sched["daily"][0]["start"] == "00:00"
    assert sched["daily"][0]["end"] == "24:00"  # all day
    assert active_slot(sched, at(0, 23, 59)).slot["title"] == "Day"
    assert active_slot(sched, at(1, 0, 0)).slot["title"] == "Day"
    assert next_change(sched, at(0, 12)) == at(1, 0)
    sched = normalize_schedule({"daily": [slot("Morning", "07:00:30", "09:15:59", 21)]})
    assert (sched["daily"][0]["start"], sched["daily"][0]["end"]) == ("07:00", "09:15")
