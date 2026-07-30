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
  * it only ever ADDS monitors whose name is not already present, so a monitor
    an admin edited, paused or deleted on purpose is never resurrected;
  * every failure is logged and swallowed -- provisioning must never be able to
    stop the agent from reporting.

The checks target the .lab hostnames on purpose. A check against an in-cluster
Service name would pass while every real user got a 502 from Traefik, which is
exactly the outage nobody would notice.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

log = logging.getLogger(__name__)

#: name -> monitor spec. `name` is what appears on the status page and in every
#: incident, so these read as things people do, not as infrastructure.
DEFAULT_MONITORS: list[dict[str, Any]] = [
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
              timeout: float = 25.0) -> int:
    """Add any missing default monitors. Returns how many were created."""
    if not (base_url and username and password):
        log.info("kuma provisioning skipped: no credentials configured")
        return 0

    try:
        import socketio  # imported here so a missing extra cannot stop the agent
    except ImportError:
        log.warning("python-socketio not installed; skipping monitor provisioning")
        return 0

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

        result = sio.call("login", {"username": username, "password": password,
                                    "token": ""}, timeout=timeout)
        if not (isinstance(result, dict) and result.get("ok")):
            msg = (result or {}).get("msg", "unknown error") if isinstance(result, dict) else result
            log.warning("kuma login failed: %s -- not provisioning monitors", msg)
            return 0

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
        return created
    except Exception as exc:  # noqa: BLE001
        # Provisioning is a convenience. Never let it take the agent down.
        log.warning("kuma provisioning failed: %s", exc)
        return 0
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
            created = provision(base_url, username, password)
            if created:
                log.info("provisioned %d monitor(s) on attempt %d", created, attempt)
                return
            # `0 created` is also the steady state once everything exists, so
            # stop retrying as soon as a login succeeds at all. provision()
            # cannot distinguish those, so probe cheaply: if Kuma answers the
            # HTTP port, it is up and 0 means "nothing to do".
            if _kuma_up(base_url):
                log.info("kuma reachable and no monitors missing")
                return
            time.sleep(delay)
        log.warning("gave up provisioning monitors after %d attempts", attempts)

    threading.Thread(target=run, name="kuma-provision", daemon=True).start()


def _kuma_up(base_url: str) -> bool:
    try:
        import httpx
        return httpx.get(base_url, timeout=4).status_code < 500
    except Exception:  # noqa: BLE001
        return False
