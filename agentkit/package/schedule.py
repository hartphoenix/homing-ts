"""Small, timezone-local scheduling policy shared by the runner and its tests."""

from datetime import date, datetime, time, timedelta
from typing import Optional

DAILY_TRIGGER = time(9, 0)


def scheduled_due(now: datetime, last_started_date: Optional[date]) -> bool:
    """Whether one scheduled acquisition may start now.

    The caller must claim the returned local date transactionally. Manual runs do not call
    this function and do not update the scheduled marker.
    """
    today = now.date()
    if last_started_date is not None and last_started_date >= today:
        return False
    if now.time() >= DAILY_TRIGGER:
        return True
    return last_started_date is not None and last_started_date < today - timedelta(days=1)
