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

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

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
        except (urllib.error.URLError, OSError) as err:
            log.info("kuma api unreachable: %s", err)
            return {}

        return _parse(body)


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
