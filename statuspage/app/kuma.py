"""Reading Uptime Kuma.

Uptime Kuma has no stable, documented REST API for monitor history. What it does
have is a SQLite database, and that is what this reads -- read-only, over a
volume the Kuma container also mounts.

That is a deliberate trade and worth stating plainly:

  * The alternatives are worse. The socket.io API needs a logged-in session and
    is undocumented; the Prometheus /metrics endpoint needs an API key created by
    hand in the UI and carries no history; the status-page JSON needs a status
    page to have been published first. All three need manual setup before this
    agent works at all, which defeats the point of an agent that just runs.
  * The cost is coupling to their schema. It is a small, stable schema (monitor,
    heartbeat) that has not changed shape across 1.x, and every query here is
    defensive: a missing column degrades to "no data", never to a crash.

SQLite is opened in read-only mode via a file: URI, so this process cannot
corrupt Kuma's database even with a bug. WAL mode means readers never block the
writer, so polling costs Kuma nothing.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

log = logging.getLogger(__name__)

#: Uptime Kuma heartbeat status codes.
DOWN, UP, PENDING, MAINTENANCE = 0, 1, 2, 3
STATUS_NAME = {DOWN: "down", UP: "up", PENDING: "pending", MAINTENANCE: "maintenance"}


@dataclass
class Monitor:
    id: int
    name: str
    url: str | None
    type: str | None
    active: bool
    #: Latest heartbeat, or None when the monitor has never run.
    status: int | None
    message: str | None
    last_beat: datetime | None
    #: Consecutive beats in the current state. The agent uses this to wait out
    #: flapping instead of opening an incident on a single missed ping.
    streak: int

    @property
    def is_down(self) -> bool:
        return self.status == DOWN

    @property
    def is_up(self) -> bool:
        return self.status in (UP, MAINTENANCE)


@dataclass
class DayStat:
    day: str          # YYYY-MM-DD
    up: int
    down: int

    @property
    def total(self) -> int:
        return self.up + self.down

    @property
    def ratio(self) -> float | None:
        """Uptime for the day, or None when nothing was recorded.

        None and 1.0 are different facts and the status page draws them
        differently: a grey bar for "we were not watching" is honest, a green bar
        would be a lie about a period we know nothing about.
        """
        return (self.up / self.total) if self.total else None


class Kuma:
    def __init__(self, db_path: str):
        self.db_path = db_path

    # --- connection -----------------------------------------------------------

    def _connect(self) -> sqlite3.Connection | None:
        if not os.path.exists(self.db_path):
            return None
        try:
            # mode=ro is enforced by SQLite itself, not by convention: this
            # process physically cannot write Kuma's database.
            conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=5)
            conn.row_factory = sqlite3.Row
            return conn
        except sqlite3.Error as exc:
            log.warning("cannot open kuma database: %s", exc)
            return None

    def available(self) -> bool:
        conn = self._connect()
        if conn is None:
            return False
        try:
            conn.execute("SELECT 1 FROM monitor LIMIT 1")
            return True
        except sqlite3.Error:
            # The file exists but Kuma has not created its tables yet -- normal
            # for the seconds between first start and first run.
            return False
        finally:
            conn.close()

    # --- reads ----------------------------------------------------------------

    def monitors(self) -> list[Monitor]:
        conn = self._connect()
        if conn is None:
            return []
        try:
            rows = conn.execute(
                """SELECT m.id, m.name, m.url, m.type, m.active
                     FROM monitor m
                    WHERE m.active = 1
                    ORDER BY m.name"""
            ).fetchall()

            out: list[Monitor] = []
            for r in rows:
                beat = conn.execute(
                    """SELECT status, msg, time FROM heartbeat
                        WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1""",
                    (r["id"],),
                ).fetchone()

                streak = 0
                if beat is not None:
                    # How long has it been in this state? Counted over a bounded
                    # window: an unbounded scan of a monitor that has been up for
                    # a year would read a million rows every poll.
                    recent = conn.execute(
                        """SELECT status FROM heartbeat
                            WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 200""",
                        (r["id"],),
                    ).fetchall()
                    for h in recent:
                        if h["status"] == beat["status"]:
                            streak += 1
                        else:
                            break

                out.append(Monitor(
                    id=r["id"], name=r["name"], url=r["url"], type=r["type"],
                    active=bool(r["active"]),
                    status=beat["status"] if beat else None,
                    message=(beat["msg"] if beat else None),
                    last_beat=_parse(beat["time"]) if beat else None,
                    streak=streak,
                ))
            return out
        except sqlite3.Error as exc:
            log.warning("kuma monitor read failed: %s", exc)
            return []
        finally:
            conn.close()

    def recent_beats(self, monitor_id: int, limit: int = 30) -> list[dict[str, Any]]:
        """The last few heartbeats, newest first. Context for the incident writer."""
        conn = self._connect()
        if conn is None:
            return []
        try:
            rows = conn.execute(
                """SELECT status, msg, time, ping FROM heartbeat
                    WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT ?""",
                (monitor_id, limit),
            ).fetchall()
            return [{"status": STATUS_NAME.get(r["status"], "?"), "message": r["msg"],
                     "at": r["time"], "ping_ms": r["ping"]} for r in rows]
        except sqlite3.Error:
            return []
        finally:
            conn.close()

    def daily_uptime(self, monitor_id: int, days: int = 90) -> list[DayStat]:
        """Per-day up/down counts, oldest first -- the bar strip on the status page."""
        conn = self._connect()
        if conn is None:
            return []
        since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        try:
            rows = conn.execute(
                """SELECT substr(time, 1, 10) AS day,
                          sum(CASE WHEN status IN (1,3) THEN 1 ELSE 0 END) AS up,
                          sum(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS down
                     FROM heartbeat
                    WHERE monitor_id = ? AND substr(time, 1, 10) >= ?
                    GROUP BY day ORDER BY day""",
                (monitor_id, since),
            ).fetchall()
        except sqlite3.Error:
            return []
        finally:
            conn.close()

        seen = {r["day"]: DayStat(r["day"], r["up"] or 0, r["down"] or 0) for r in rows}
        # Fill the gaps so the strip always has one cell per day. A missing day is
        # a real state -- "not monitored" -- and is rendered grey, not green.
        today = datetime.now(timezone.utc).date()
        return [seen.get((today - timedelta(days=n)).isoformat(),
                         DayStat((today - timedelta(days=n)).isoformat(), 0, 0))
                for n in range(days - 1, -1, -1)]

    def overall_uptime(self, monitor_id: int, days: int = 90) -> float | None:
        stats = [d for d in self.daily_uptime(monitor_id, days) if d.total]
        if not stats:
            return None
        up = sum(d.up for d in stats)
        total = sum(d.total for d in stats)
        return up / total if total else None


def _parse(value: Any) -> datetime | None:
    """Kuma writes 'YYYY-MM-DD HH:MM:SS' in UTC (and sometimes ISO with a T)."""
    if not value:
        return None
    text = str(value).replace("T", " ").split(".")[0].replace("Z", "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None
