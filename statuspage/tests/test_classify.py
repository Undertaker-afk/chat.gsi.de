"""Classifier tests that go through Kuma's real beat shape.

    python3 statuspage/tests/test_classify.py

No pytest: this service ships with httpx and stdlib, and a test dependency it
cannot install in the cluster is a test nobody runs.

The point of building a real SQLite database instead of hand-writing beat dicts:
the bug these tests exist for was a *shape* mismatch. `recent_beats()` returned
`status` as a name ("up") while `classify.py` compared it to the integer 1, so
degradation was undetectable in production while synthetic-dict tests passed.
Any test that invents its own beats cannot see that, which is why these go
through `Kuma.recent_beats()`.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import classify  # noqa: E402
from app.kuma import Kuma  # noqa: E402

INTERVAL_S = 20


def build(beats: list[tuple[int, float | None]]) -> Kuma:
    """A throwaway Kuma database. `beats` is (status, ping_ms), oldest first."""
    path = os.path.join(tempfile.mkdtemp(), "kuma.db")
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE monitor (id INTEGER PRIMARY KEY, name TEXT, url TEXT,"
        " type TEXT, active INT);"
        "CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, monitor_id INT, status INT,"
        " msg TEXT, time TEXT, ping REAL);"
        "INSERT INTO monitor VALUES (1,'Target','http://x','http',1);"
    )
    now = datetime.now(timezone.utc)
    for n, (status, ping) in enumerate(reversed(beats)):
        at = now - timedelta(seconds=INTERVAL_S * n)
        conn.execute(
            "INSERT INTO heartbeat (monitor_id,status,msg,time,ping) VALUES (1,?,?,?,?)",
            (status, "200 - OK" if status == 1 else "503", at.strftime("%Y-%m-%d %H:%M:%S"), ping),
        )
    conn.commit()
    conn.close()
    return Kuma(path)


def verdict(beats: list[tuple[int, float | None]]):
    kuma = build(beats)
    return classify.classify(component="Target", beats=kuma.recent_beats(1, limit=120),
                             detail="", rollout=None, in_maintenance=False)


def check(name: str, got, want) -> bool:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: got {got!r}, want {want!r}")
    return ok


def main() -> int:
    fast = [(1, 12.0)] * 10
    results = []

    # The drill's degraded phase, as Kuma actually recorded it: a fast history,
    # then 1.5 s answers for longer than DEGRADED_AFTER_S. This is the case that
    # silently returned "outage" for months.
    slow_run = [(1, 1510.0)] * (classify.DEGRADED_AFTER_S // INTERVAL_S + 2)
    results.append(check("1.5 s for over 2 min is degraded", verdict(fast + slow_run).kind,
                         "degraded"))

    # Under the floor is not degradation however far it has drifted from a
    # single-digit-ms habit. 900 ms is 75x the baseline and still not reportable.
    results.append(check("900 ms stays ok (under the 1 s floor)",
                         verdict(fast + [(1, 900.0)] * len(slow_run)).kind, "ok"))

    # A slow run must not become its own baseline. With the median taken over all
    # healthy beats the threshold climbs to 3x 1510 ms and the verdict flips back
    # to ok partway through -- before the 2 min mark, so nothing is ever reported.
    long_slow = [(1, 1510.0)] * 40
    results.append(check("a long slow run does not normalise itself",
                         verdict(fast + long_slow).kind, "degraded"))

    # Down outranks slow, and below the outage threshold nothing is reported.
    down_run = [(0, None)] * (classify.OUTAGE_AFTER_S // INTERVAL_S + 2)
    results.append(check("sustained failure is an outage", verdict(fast + down_run).kind,
                         "outage"))
    results.append(check("a brief failure is not", verdict(fast + [(0, None)] * 2).kind, "ok"))

    # No fast history at all: nothing to compare against, so no claim is made.
    results.append(check("always-slow has no baseline to judge against",
                         verdict([(1, 1510.0)] * 20).kind, "ok"))

    print(f"\n{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
