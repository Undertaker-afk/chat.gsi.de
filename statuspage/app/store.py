"""Incident storage.

Its own SQLite file, deliberately not the application's Postgres. A status page
that goes down with the thing it reports on is worse than no status page: the one
moment anybody reads it is the moment the database is unreachable. This service
shares nothing with the stack it watches except a read-only view of Kuma's
database.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS incident (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at    TEXT NOT NULL,
    resolved_at  TEXT,
    -- minor: one non-critical component. major: a user-facing component.
    -- critical: the app itself is unreachable. degraded: working but slow.
    -- maintenance: down on purpose. See SEVERITIES below.
    severity     TEXT NOT NULL DEFAULT 'minor',
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    -- JSON array of monitor names. Stored denormalised because a monitor can be
    -- renamed or deleted in Kuma and an incident must still read correctly a
    -- year later -- history has to be immutable to be worth keeping.
    components   TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL DEFAULT 'investigating',
    -- 1 when the narrative came from the model, 0 when it is the deterministic
    -- fallback. Surfaced on the page: a reader deserves to know which they are
    -- reading.
    ai_written   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS incident_update (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id  INTEGER NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
    at           TEXT NOT NULL,
    status       TEXT NOT NULL,
    body         TEXT NOT NULL,
    ai_written   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS incident_open ON incident (resolved_at);
CREATE INDEX IF NOT EXISTS incident_time ON incident (opened_at DESC);
CREATE INDEX IF NOT EXISTS update_incident ON incident_update (incident_id, at);

-- Remembers the last state we acted on, so a restart does not re-open an
-- incident that is already open or re-announce a recovery.
CREATE TABLE IF NOT EXISTS monitor_state (
    monitor_id   INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    status       TEXT NOT NULL,
    since        TEXT NOT NULL
);
"""

# minor/major/critical are outages, in rising order of what they take out.
# degraded and maintenance are not outages at all -- one is "slow but working",
# the other "down on purpose" -- and the page draws all three differently. They
# have to be listed here: a severity missing from this tuple is silently
# rewritten to "minor" on insert, which is how a planned rollout ended up on the
# page wearing an amber MINOR badge.
SEVERITIES = ("minor", "major", "critical", "degraded", "maintenance")
#: "all_clear" is the closing note published once every component is healthy
#: again. It is a distinct status, not a second "resolved", so an incident does
#: not render two Resolved headings in a row.
STATUSES = ("investigating", "identified", "monitoring", "resolved",
            "degraded", "maintenance", "all_clear")


@dataclass
class Update:
    at: str
    status: str
    body: str
    ai_written: bool = False


@dataclass
class Incident:
    id: int
    opened_at: str
    resolved_at: str | None
    severity: str
    title: str
    summary: str
    components: list[str]
    status: str
    ai_written: bool
    updates: list[Update] = field(default_factory=list)

    @property
    def is_open(self) -> bool:
        return self.resolved_at is None

    @property
    def duration_minutes(self) -> int | None:
        if not self.resolved_at:
            return None
        a = datetime.fromisoformat(self.opened_at)
        b = datetime.fromisoformat(self.resolved_at)
        return max(1, round((b - a).total_seconds() / 60))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str):
        self.path = path
        # One lock around writes. SQLite handles concurrency itself, but the
        # agent thread and the web thread both touch this and serialising here is
        # simpler to reason about than relying on busy-timeout semantics.
        self._lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        # WAL so a long read on the history page never blocks the agent writing
        # an incident -- which is precisely when both happen at once.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    # --- incidents ------------------------------------------------------------

    def open_incident(self, *, title: str, summary: str, severity: str,
                      components: list[str], ai_written: bool) -> int:
        severity = severity if severity in SEVERITIES else "minor"
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                """INSERT INTO incident (opened_at, severity, title, summary,
                                         components, status, ai_written)
                   VALUES (?, ?, ?, ?, ?, 'investigating', ?)""",
                (_now(), severity, title, summary, json.dumps(components), int(ai_written)),
            )
            return int(cur.lastrowid)

    def add_update(self, incident_id: int, status: str, body: str,
                   ai_written: bool = False) -> None:
        status = status if status in STATUSES else "investigating"
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO incident_update (incident_id, at, status, body, ai_written)"
                " VALUES (?, ?, ?, ?, ?)",
                (incident_id, _now(), status, body, int(ai_written)),
            )
            if status != "all_clear":
                # The all-clear is published after resolve() and must not move
                # the incident off "resolved".
                conn.execute("UPDATE incident SET status = ? WHERE id = ?",
                             (status, incident_id))

    def add_components(self, incident_id: int, components: list[str]) -> list[str]:
        """Merge newly-affected components into an open incident. Returns the new set."""
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT components FROM incident WHERE id = ?", (incident_id,)).fetchone()
            current = json.loads(row["components"]) if row else []
            merged = sorted(set(current) | set(components))
            conn.execute("UPDATE incident SET components = ? WHERE id = ?",
                         (json.dumps(merged), incident_id))
            return merged

    def set_severity(self, incident_id: int, severity: str) -> None:
        if severity not in SEVERITIES:
            return
        with self._lock, self._connect() as conn:
            conn.execute("UPDATE incident SET severity = ? WHERE id = ?",
                         (severity, incident_id))

    def resolve(self, incident_id: int, body: str, ai_written: bool = False) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO incident_update (incident_id, at, status, body, ai_written)"
                " VALUES (?, ?, 'resolved', ?, ?)",
                (incident_id, _now(), body, int(ai_written)),
            )
            conn.execute(
                "UPDATE incident SET resolved_at = ?, status = 'resolved' WHERE id = ?",
                (_now(), incident_id),
            )

    def open_incidents(self) -> list[Incident]:
        return self._incidents("WHERE resolved_at IS NULL ORDER BY opened_at DESC")

    def recent(self, limit: int = 100) -> list[Incident]:
        return self._incidents(f"ORDER BY opened_at DESC LIMIT {int(limit)}")

    def get(self, incident_id: int) -> Incident | None:
        found = self._incidents("WHERE id = ?", (incident_id,))
        return found[0] if found else None

    def _incidents(self, where: str, params: tuple = ()) -> list[Incident]:
        with self._connect() as conn:
            rows = conn.execute(f"SELECT * FROM incident {where}", params).fetchall()
            out = []
            for r in rows:
                ups = conn.execute(
                    "SELECT at, status, body, ai_written FROM incident_update"
                    " WHERE incident_id = ? ORDER BY at",
                    (r["id"],),
                ).fetchall()
                out.append(Incident(
                    id=r["id"], opened_at=r["opened_at"], resolved_at=r["resolved_at"],
                    severity=r["severity"], title=r["title"], summary=r["summary"],
                    components=json.loads(r["components"]), status=r["status"],
                    ai_written=bool(r["ai_written"]),
                    updates=[Update(u["at"], u["status"], u["body"], bool(u["ai_written"]))
                             for u in ups],
                ))
            return out

    # --- remembered monitor state --------------------------------------------

    def last_state(self) -> dict[int, str]:
        with self._connect() as conn:
            return {r["monitor_id"]: r["status"]
                    for r in conn.execute("SELECT monitor_id, status FROM monitor_state")}

    def remember(self, monitor_id: int, name: str, status: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO monitor_state (monitor_id, name, status, since)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(monitor_id) DO UPDATE SET
                       name = excluded.name, status = excluded.status,
                       since = CASE WHEN monitor_state.status = excluded.status
                                    THEN monitor_state.since ELSE excluded.since END""",
                (monitor_id, name, status, _now()),
            )

    def find_open_for(self, component: str) -> Incident | None:
        """The open incident already covering this component, if any.

        Without this an outage that trips three monitors would produce three
        incidents for what a reader experiences as one event.
        """
        for inc in self.open_incidents():
            if component in inc.components:
                return inc
        return None
