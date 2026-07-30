"""In-pod helper for the status-page drill (see deploy/status-drill.py).

Runs inside the `agent` container, where three things it needs already live:
Kuma's socket.io API (for creating and deleting the throwaway test monitor), the
admin credentials (in the environment), and the agent's own incident SQLite at
STATUS_DB -- the very file the running agent writes its verdicts to. The host
orchestrator shells into here with `kubectl exec` for each step.

Nothing here is used in normal operation. It is a test instrument, kept in the
image so it can reach Kuma and the store without a second image to build.

Subcommands:

    add-monitor   create the test monitor if absent, print its id
    del-monitor   delete it by name
    await         block until the store shows the expected verdict, or time out
    purge         delete the test monitor's incidents from the store
    show          dump current incidents touching a component (debugging)

`await` reads *recent* incidents, not only open ones, on purpose: the degraded
path can open and resolve within a poll or two (see the note in status-page.md),
and a drill that only looked at currently-open incidents would miss it.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone

from .store import Store

# --- environment ------------------------------------------------------------


def _env(key: str, default: str = "") -> str:
    import os

    return os.environ.get(key, default).strip()


def _kuma_url() -> str:
    return _env("KUMA_URL", "http://127.0.0.1:3001")


def _store() -> Store:
    return Store(_env("STATUS_DB", "/data/status.db"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- severity -> the kind of event the drill asserts on ---------------------

# The store records a severity; the drill thinks in kinds. degraded and
# maintenance are their own severities, everything else is an outage of some size.
def _kind(severity: str) -> str:
    if severity == "degraded":
        return "degraded"
    if severity == "maintenance":
        return "maintenance"
    return "outage"


# --- Kuma socket.io ---------------------------------------------------------


class _KumaSocket:
    """A short-lived logged-in socket.io session, just for add/delete.

    Mirrors provision.py: Kuma pushes the monitor list as an event after login
    rather than answering a request, so we wait for that push.
    """

    def __init__(self, timeout: float = 25.0):
        import socketio  # late import: a missing extra should not crash --help

        self.timeout = timeout
        self.sio = socketio.Client(reconnection=False, request_timeout=timeout)
        self.monitors: dict = {}
        self._ready = threading.Event()

        @self.sio.on("monitorList")
        def _list(data):  # noqa: ANN001
            self.monitors = data or {}
            self._ready.set()

    def __enter__(self) -> "_KumaSocket":
        user = _env("KUMA_ADMIN_USER")
        password = _env("KUMA_ADMIN_PASSWORD")
        if not (user and password):
            raise SystemExit("drill: KUMA_ADMIN_USER / KUMA_ADMIN_PASSWORD not set in the pod")
        self.sio.connect(_kuma_url(), transports=["websocket"], wait_timeout=self.timeout)
        result = self.sio.call("login", {"username": user, "password": password, "token": ""},
                               timeout=self.timeout)
        if not (isinstance(result, dict) and result.get("ok")):
            raise SystemExit(f"drill: kuma login failed: {result}")
        self._ready.wait(timeout=10)
        return self

    def __exit__(self, *_):
        try:
            self.sio.disconnect()
        except Exception:  # noqa: BLE001
            pass

    def find(self, name: str) -> int | None:
        target = name.strip().lower()
        for mid, mon in self.monitors.items():
            if str(mon.get("name", "")).strip().lower() == target:
                try:
                    return int(mid)
                except (TypeError, ValueError):
                    return int(mon.get("id")) if mon.get("id") is not None else None
        return None

    def add(self, name: str, url: str, interval: int) -> int:
        payload = {
            "type": "http", "name": name, "url": url, "method": "GET",
            "interval": interval, "retryInterval": interval, "maxretries": 1,
            "timeout": max(2, min(interval - 1, 10)),
            "accepted_statuscodes": ["200-299"], "active": True,
            "expiryNotification": False, "ignoreTls": True, "upsideDown": False,
            "maxredirects": 2, "notificationIDList": {},
        }
        reply = self.sio.call("add", payload, timeout=self.timeout)
        if not (isinstance(reply, dict) and reply.get("ok")):
            raise SystemExit(f"drill: could not add monitor: {reply}")
        return int(reply.get("monitorID"))

    def delete(self, monitor_id: int) -> None:
        self.sio.call("deleteMonitor", monitor_id, timeout=self.timeout)


# --- subcommands ------------------------------------------------------------


def cmd_add_monitor(args) -> int:
    with _KumaSocket() as k:
        existing = k.find(args.name)
        if existing is not None:
            print(f"exists {existing}")
            return 0
        mid = k.add(args.name, args.url, args.interval)
        print(f"created {mid}")
    return 0


def cmd_del_monitor(args) -> int:
    with _KumaSocket() as k:
        mid = k.find(args.name)
        if mid is None:
            print("absent")
            return 0
        k.delete(mid)
        print(f"deleted {mid}")
    return 0


def _incidents_for(store: Store, component: str, since: str | None):
    for inc in store.recent(80):
        if component not in inc.components:
            continue
        if since and inc.opened_at < since:
            continue
        yield inc


def _describe(inc) -> str:
    tag = "AI" if inc.ai_written else "template"
    last = inc.updates[-1].body if inc.updates else inc.summary
    return (f"    #{inc.id} [{inc.severity}/{inc.status}] ({tag}) {inc.title!r}\n"
            f"      {last.strip()[:400]}")


def cmd_await(args) -> int:
    """Block until the store shows `expect` for `component`, or time out.

    ok        -> no OPEN incident for the component
    degraded  -> a degraded incident opened since --since (open OR already resolved)
    outage    -> a non-maintenance outage incident opened since --since
    maintenance -> a maintenance incident opened since --since
    """
    store = _store()
    deadline = time.monotonic() + args.timeout
    want = args.expect
    seen_note = ""

    while time.monotonic() < deadline:
        if want == "ok":
            still_open = [i for i in store.open_incidents() if args.component in i.components]
            if not still_open:
                print(f"ok: no open incident for {args.component!r}")
                return 0
            seen_note = f"still open: #{still_open[0].id} {still_open[0].severity}"
        else:
            matches = [i for i in _incidents_for(store, args.component, args.since)
                       if _kind(i.severity) == want]
            if matches:
                inc = matches[0]
                print(f"{want}: incident detected for {args.component!r}")
                print(_describe(inc))
                return 0
            recent = list(_incidents_for(store, args.component, args.since))
            seen_note = ("seen: " + ", ".join(f"{i.severity}/{i.status}" for i in recent[:4])
                         if recent else "nothing yet")

        remaining = int(deadline - time.monotonic())
        print(f"  waiting for {want} on {args.component!r} ... {remaining}s left ({seen_note})",
              flush=True)
        time.sleep(args.every)

    print(f"TIMEOUT after {args.timeout}s waiting for {want} on {args.component!r} "
          f"({seen_note})", file=sys.stderr)
    return 1


def cmd_purge(args) -> int:
    """Delete the test monitor's incidents and remembered state from the store.

    Raw SQL rather than a Store method: deleting incident history is something the
    product must never do, so it lives only in this test tool, not in Store.
    """
    store = _store()
    ids = [inc.id for inc in store.recent(500) if args.name in inc.components]
    conn = sqlite3.connect(store.path, timeout=10)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        for iid in ids:
            conn.execute("DELETE FROM incident_update WHERE incident_id = ?", (iid,))
            conn.execute("DELETE FROM incident WHERE id = ?", (iid,))
        conn.execute("DELETE FROM monitor_state WHERE name = ?", (args.name,))
        conn.commit()
    finally:
        conn.close()
    print(f"purged {len(ids)} incident(s) for {args.name!r}")
    return 0


def cmd_show(args) -> int:
    store = _store()
    rows = list(_incidents_for(store, args.component, None))
    print(json.dumps({"component": args.component, "incidents": len(rows)}))
    for inc in rows[:10]:
        print(_describe(inc))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.drilltools", description="status-page drill helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add-monitor")
    p.add_argument("--name", required=True)
    p.add_argument("--url", required=True)
    p.add_argument("--interval", type=int, default=20)
    p.set_defaults(func=cmd_add_monitor)

    p = sub.add_parser("del-monitor")
    p.add_argument("--name", required=True)
    p.set_defaults(func=cmd_del_monitor)

    p = sub.add_parser("await")
    p.add_argument("--component", required=True)
    p.add_argument("--expect", required=True,
                   choices=["ok", "degraded", "outage", "maintenance"])
    p.add_argument("--timeout", type=int, default=300)
    p.add_argument("--every", type=int, default=5)
    p.add_argument("--since", default=None)
    p.set_defaults(func=cmd_await)

    p = sub.add_parser("purge")
    p.add_argument("--name", required=True)
    p.set_defaults(func=cmd_purge)

    p = sub.add_parser("show")
    p.add_argument("--component", required=True)
    p.set_defaults(func=cmd_show)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
