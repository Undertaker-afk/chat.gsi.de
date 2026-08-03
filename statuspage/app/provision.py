"""Create the default monitors in Uptime Kuma, once.

Why this exists rather than a README step: the whole point of this service is
that it runs on its own. A status page that silently shows nothing until somebody
remembers to click through a setup wizard is a status page that will be wrong on
the day it matters -- and a rebuilt volume would put it back to nothing.

This is the one place that WRITES to Uptime Kuma, and it goes through the real
socket.io API rather than touching the database, because writing another
process's SQLite behind its back is how you corrupt it. `kuma.py` stays read-only.

It is deliberately timid:

  * it does nothing at all unless credentials are configured;
  * it only ever ADDS monitors whose name is not already present, so one an admin
    renamed, paused, retargeted or reconfigured is left exactly as it is;
  * every failure is logged and swallowed -- provisioning must never be able to
    stop the agent from reporting.

A monitor DELETED on purpose does come back on the next restart, because a
deleted monitor and a never-created one are the same absence and this cannot
tell them apart. That is the deal: coverage is restored automatically after a
rebuilt volume, at the cost of not being able to permanently remove one of the
defaults. Pause it instead, or take it out of DEFAULT_MONITORS.

## What each check aims at

User-facing components are checked through their .lab hostname on purpose: a
check against an in-cluster Service name would pass while every real user got a
502 from Traefik, which is exactly the outage nobody would notice.

Internal components (the database, the cache, the log store, the storage cluster
behind the S3 gateway) have no ingress at all, so they are checked over
in-cluster Service DNS. There is no user-facing path to test, and "nobody can
reach it from outside" is not a fact about them.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, NamedTuple

log = logging.getLogger(__name__)


class Result(NamedTuple):
    """The outcome of one provisioning attempt.

    `ok` means we got far enough to know the monitor list is right -- logged in,
    compared, created whatever was missing. Everything else is a reason to try
    again later.

    This exists because the old signature returned a bare `created` count, so
    "login failed" and "nothing to do" were both 0. The caller read that 0, saw
    Kuma answering on its HTTP port, logged "kuma reachable and no monitors
    missing" and stopped retrying -- permanently, on a cluster where Kuma had
    zero monitors and the page therefore said Status Unknown. Two different
    facts must not share a return value.
    """

    ok: bool
    created: int
    detail: str = ""

#: name -> monitor spec. `name` is what appears on the status page and in every
#: incident, so these read as things people do, not as infrastructure.
#:
#: Names also feed two lookups, so they are not free-form: `writer.IMPACT` turns
#: them into user-facing consequences, and `agent.CRITICAL_HINTS` decides which
#: failures are severe. Both match on substrings, which is why the infrastructure
#: word stays in the name alongside the readable one.
DEFAULT_MONITORS: list[dict[str, Any]] = [
    # --- what a user touches directly, checked the way a user reaches it ------
    {"name": "Chat interface", "url": "http://chat.lab/health",
     "description": "The web app itself, through Traefik."},
    {"name": "Sign-in (Keycloak)",
     "url": "http://keycloak.lab/realms/gsi/.well-known/openid-configuration",
     "description": "OIDC discovery. If this fails, nobody can log in."},
    {"name": "File storage", "url": "http://s3.lab/healthz",
     "description": "SeaweedFS S3 gateway: uploads and downloads."},
    {"name": "Dashboards (Grafana)", "url": "http://grafana.lab/api/health",
     "description": "Internal only. Failure does not affect users."},
    {"name": "Monitoring (Prometheus)", "url": "http://prometheus.lab/-/healthy",
     "description": "Internal only. Failure does not affect users."},

    # --- what everything above stands on, checked over Service DNS -----------
    # No ingress exists for these, and the S3 gateway answering says nothing
    # about whether the cluster behind it can still store a file.
    {"name": "Conversation history (database)", "type": "port",
     "hostname": "db", "port": 5432,
     "description": "Postgres. Conversations cannot be loaded or saved without it."},
    {"name": "Sessions (Valkey)", "type": "port",
     "hostname": "valkey", "port": 6379,
     "description": "Session and cache store. Users get signed out without it."},
    {"name": "File storage index (SeaweedFS filer)",
     "url": "http://seaweed-filer:8888/",
     "description": "Maps names to volumes. Uploads fail without it."},
    {"name": "File storage cluster (SeaweedFS master)",
     "url": "http://seaweed-master:9333/cluster/healthz",
     "description": "Assigns volumes. Uploads fail without it."},
    {"name": "File storage volumes (SeaweedFS)",
     "url": "http://seaweed-volume:8080/status",
     "description": "Where the bytes live."},
    {"name": "Log search (Loki)", "url": "http://loki:3100/ready",
     "description": "Internal only. Failure does not affect users."},
]

# Kuma rejects an accepted_statuscodes list it does not recognise, and 200-299 is
# the default it ships with.
BASE = {
    "type": "http", "method": "GET", "interval": 60, "retryInterval": 60,
    "maxretries": 1, "timeout": 30, "accepted_statuscodes": ["200-299"],
    "active": True, "expiryNotification": False, "ignoreTls": True,
    "upsideDown": False, "maxredirects": 5, "notificationIDList": {},
}


def provision(base_url: str, username: str, password: str,
              monitors: list[dict[str, Any]] | None = None,
              timeout: float = 25.0) -> Result:
    """Add any missing default monitors, creating the admin account if Kuma is new."""
    if not (base_url and username and password):
        log.info("kuma provisioning skipped: no credentials configured")
        return Result(True, 0, "no credentials configured")

    try:
        import socketio  # imported here so a missing extra cannot stop the agent
    except ImportError:
        log.warning("python-socketio not installed; skipping monitor provisioning")
        return Result(True, 0, "python-socketio not installed")

    wanted = monitors if monitors is not None else DEFAULT_MONITORS
    sio = socketio.Client(reconnection=False, request_timeout=timeout)
    created = 0
    # Kuma pushes the monitor list as an event after login rather than answering a
    # request for it, so we wait for that push instead of asking.
    existing: dict[str, Any] = {}
    ready = threading.Event()

    @sio.on("monitorList")
    def _monitor_list(data):  # noqa: ANN001
        existing.clear()
        existing.update(data or {})
        ready.set()

    try:
        sio.connect(base_url, transports=["websocket"], wait_timeout=timeout)

        # A Kuma with no user at all cannot be logged into: the account has to be
        # created first, through the same wizard a human would click. Without
        # this a rebuilt volume leaves the page permanently blank until somebody
        # opens Kuma by hand -- which is the failure this whole module exists to
        # prevent, just moved one step earlier.
        if _needs_setup(sio, timeout):
            reply = sio.call("setup", (username, password), timeout=timeout)
            if isinstance(reply, dict) and reply.get("ok"):
                log.info("kuma had no account: created %r from KUMA_ADMIN_USER", username)
            else:
                msg = reply.get("msg") if isinstance(reply, dict) else reply
                # Kuma refuses a password under 6 characters or without digits.
                log.warning("kuma first-run setup failed: %s", msg)
                return Result(False, 0, f"setup failed: {msg}")

        result = sio.call("login", {"username": username, "password": password,
                                    "token": ""}, timeout=timeout)
        if not (isinstance(result, dict) and result.get("ok")):
            msg = (result or {}).get("msg", "unknown error") if isinstance(result, dict) else result
            # Not retryable by us: the account exists with a different password.
            # Said loudly because the page shows nothing at all until it is fixed.
            log.error("kuma login failed: %s -- KUMA_ADMIN_PASSWORD does not match the "
                      "account in Kuma's database, so NO monitors can be created and the "
                      "status page will report nothing", msg)
            return Result(False, 0, f"login failed: {msg}")

        ready.wait(timeout=10)
        have = {str(m.get("name", "")).strip().lower() for m in existing.values()}
        log.info("kuma has %d monitor(s) already", len(have))

        for spec in wanted:
            if spec["name"].strip().lower() in have:
                continue
            payload = {**BASE, **spec}
            reply = sio.call("add", payload, timeout=timeout)
            if isinstance(reply, dict) and reply.get("ok"):
                created += 1
                log.info("created monitor %r", spec["name"])
            else:
                log.warning("could not create monitor %r: %s", spec["name"], reply)
        missing = [s["name"] for s in wanted if s["name"].strip().lower() not in have]
        if missing and not created:
            return Result(False, 0, f"could not create: {', '.join(missing)}")
        return Result(True, created, "up to date")
    except Exception as exc:  # noqa: BLE001
        # Provisioning is a convenience. Never let it take the agent down.
        log.warning("kuma provisioning failed: %s", exc)
        return Result(False, 0, str(exc))
    finally:
        try:
            sio.disconnect()
        except Exception:  # noqa: BLE001
            pass


def provision_when_ready(base_url: str, username: str, password: str,
                         attempts: int = 20, delay: float = 15.0) -> None:
    """Retry in the background until Kuma is up enough to accept a login.

    On a cold start this container and Kuma start together, and Kuma needs the
    better part of a minute before its socket accepts anything. Blocking the
    agent on that would delay the first poll for no reason, so it runs on its own
    thread and the status page serves "no checks configured yet" meanwhile --
    which is true.
    """
    def run() -> None:
        for attempt in range(1, attempts + 1):
            result = provision(base_url, username, password)
            if result.ok:
                if result.created:
                    log.info("provisioned %d monitor(s) on attempt %d",
                             result.created, attempt)
                else:
                    log.info("kuma monitor list is complete (%s)", result.detail)
                return
            # Not ok: Kuma answering its HTTP port proves nothing here. It was
            # answering all along on the cluster where this quit after one failed
            # login and left the page blank.
            log.info("provisioning attempt %d/%d did not succeed (%s), retrying in %.0fs",
                     attempt, attempts, result.detail, delay)
            time.sleep(delay)
        log.error("gave up provisioning monitors after %d attempts -- Uptime Kuma has "
                  "no checks from this agent and the status page will show nothing",
                  attempts)

    threading.Thread(target=run, name="kuma-provision", daemon=True).start()


def _needs_setup(sio: Any, timeout: float) -> bool:
    """Whether Kuma still has no account (a fresh database).

    Answering "no" on any doubt is the safe direction: a spurious `setup` call
    against an initialised Kuma is refused by the server anyway, but skipping a
    real one only costs a retry.
    """
    try:
        return bool(sio.call("needSetup", timeout=timeout))
    except Exception as exc:  # noqa: BLE001
        log.debug("needSetup check failed (%s); assuming kuma is initialised", exc)
        return False
