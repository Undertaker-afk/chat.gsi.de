"""
Uptime Kuma's own API, via an API key.

`kuma.py` reads Kuma's SQLite because, at the time it was written, every Kuma API
route needed manual setup first -- a session, an API key, or a published status
page -- which defeats an agent that is supposed to just run. An API key now
exists, so live state comes from the documented interface instead.

## What the key actually unlocks

Less than people expect. Verified against uptime.lab on 2026-07-30 with
`curl -u ":$KEY"`:

    /metrics                    200  Prometheus exposition   <- this is the one
    /api/entry-page             200  JSON, no monitor data
    /api/status-page/heartbeat  times out

So an API key buys `/metrics`, and `/metrics` is a SNAPSHOT: current status and
current response time per monitor, with no history at all.

## Which is why both sources are still here

    /metrics (API key)  ->  live status and response time  (authoritative, now)
    SQLite (read-only)  ->  heartbeat history, 90-day bars (the past)

They are not redundant. The API cannot answer "was it slow for the last two
minutes" and the database can. Using the API for the present is still worth it:
it is the supported interface, it reflects Kuma's own view rather than our
reading of its schema, and it keeps working if the database layout changes.

Auth is HTTP Basic with an EMPTY username and the key as the password -- Kuma's
scheme, and the empty username is not a mistake.

## When the key is wrong

A 401 is final, not transient: the key arrives from the environment, and the
environment cannot change without restarting this process, so the next poll can
only produce the same 401. It is therefore logged once, loudly enough to be
actionable, and the API path then switches itself off for the lifetime of the
container. The page carries on unaffected -- everything it displays is read from
the database -- so this degrades detail, never availability.
"""

from __future__ import annotations

import base64
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

log = logging.getLogger(__name__)

TIMEOUT_S = 6.0

#: `monitor_status{monitor_name="Chat interface",...} 1`
_SAMPLE = re.compile(
    r'^(?P<metric>monitor_status|monitor_response_time)\{(?P<labels>[^}]*)\}\s+(?P<value>[-\d.eE+]+)\s*$'
)
_LABEL = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')

#: Kuma's own encoding, from the /metrics HELP text.
STATUS = {0: "down", 1: "up", 2: "pending", 3: "maintenance"}


@dataclass
class LiveMonitor:
    name: str
    status: str
    response_ms: float | None
    url: str | None

    @property
    def is_down(self) -> bool:
        return self.status == "down"

    @property
    def in_maintenance(self) -> bool:
        """Somebody put this monitor into maintenance IN KUMA, which is explicit
        intent and outranks anything the agent might infer from Kubernetes."""
        return self.status == "maintenance"


class KumaApi:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        #: Set after Kuma rejects the key. A 401 is a configuration fault, not a
        #: blip: the key comes from the environment, the environment cannot
        #: change without restarting this process, so retrying it every poll can
        #: only ever produce the same 401. Left unhandled it did exactly that --
        #: one identical line in Loki every 30 seconds, forever, for a condition
        #: no amount of waiting fixes.
        self._rejected = False
        #: Suppresses duplicate lines for transient failures too. The first is
        #: worth a line; the two thousandth is not.
        self._last_error: str | None = None
        self._failures = 0

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key) and not self._rejected

    @property
    def rejected(self) -> bool:
        """Whether Kuma refused the key. The page still works: everything it
        shows comes from the database, and only live status and response time
        are lost."""
        return self._rejected

    def monitors(self) -> dict[str, LiveMonitor]:
        """
        Live state keyed by monitor name, or empty when unavailable.

        Never raises. This runs on every poll of a page whose whole job is to
        keep reporting, so an unreachable Kuma degrades to "use the database"
        rather than to a stack trace.
        """
        if not self.configured:
            return {}

        request = urllib.request.Request(f"{self.base_url}/metrics")
        token = base64.b64encode(f":{self.api_key}".encode()).decode()
        request.add_header("Authorization", f"Basic {token}")

        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
                body = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                self._rejected = True
                log.warning(
                    "kuma rejected KUMA_API_KEY (HTTP %d): live status and response "
                    "times are unavailable and will not be retried until this "
                    "container restarts. The page still works -- everything on it "
                    "comes from Kuma's database. To fix: create a key in Uptime Kuma "
                    "(Settings, API Keys), put it in the KUMA_API_KEY secret and "
                    "restart this deployment.", err.code)
            else:
                self._log_once(f"kuma api returned HTTP {err.code}")
            return {}
        except (urllib.error.URLError, OSError) as err:
            # Genuinely transient: Kuma restarting, a rollout, a timeout.
            self._log_once(f"kuma api unreachable: {err}")
            return {}

        if self._failures:
            log.info("kuma api reachable again after %d failed attempt(s)", self._failures)
            self._failures = 0
            self._last_error = None
        return _parse(body)

    def _log_once(self, message: str) -> None:
        """Log a repeating failure the first time, then stay quiet about it.

        Every poll hits this path, and an unreachable Kuma during a rollout is
        normal. One line per occurrence buries the events that matter in a log
        nobody can then read.
        """
        self._failures += 1
        if message != self._last_error:
            log.info("%s", message)
            self._last_error = message


def _parse(body: str) -> dict[str, LiveMonitor]:
    status: dict[str, float] = {}
    response: dict[str, float] = {}
    urls: dict[str, str] = {}

    for line in body.splitlines():
        match = _SAMPLE.match(line.strip())
        if not match:
            continue
        labels = dict(_LABEL.findall(match.group("labels")))
        name = labels.get("monitor_name")
        if not name:
            continue
        try:
            value = float(match.group("value"))
        except ValueError:
            continue

        if match.group("metric") == "monitor_status":
            status[name] = value
        else:
            response[name] = value
        if labels.get("monitor_url") not in (None, "null"):
            urls[name] = labels["monitor_url"]

    out: dict[str, LiveMonitor] = {}
    for name, code in status.items():
        out[name] = LiveMonitor(
            name=name,
            status=STATUS.get(int(code), "unknown"),
            # A monitor that is down still exports its last response time, which
            # would read as "it answered in 12 ms" next to "it is offline".
            response_ms=response.get(name) if int(code) == 1 else None,
            url=urls.get(name),
        )
    return out
