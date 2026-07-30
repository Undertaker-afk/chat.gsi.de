"""Optional Prometheus context.

Everything here is best-effort. This service has to keep working when the stack
it watches is down -- which is precisely when Prometheus is also likely to be
unreachable -- so every failure path returns "no extra context" rather than
raising. Uptime Kuma remains the source of truth for whether something is up;
Prometheus only adds colour the model can use ("error rate was already climbing").
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

#: Small, bounded set. Each is a question a human would actually ask while
#: reading an incident, phrased so the answer is one number.
QUERIES = {
    "http requests per second": "sum(rate(chatgsi_http_requests_total[5m]))",
    "share of requests failing with 5xx":
        '(sum(rate(chatgsi_http_requests_total{status=~"5.."}[5m])) or vector(0))'
        ' / clamp_min(sum(rate(chatgsi_http_requests_total[5m])), 0.001)',
    "backends reporting healthy": "sum(chatgsi_collector_up)",
    "backends expected": "count(chatgsi_collector_up)",
    "LLM proxy errors per minute":
        "sum(rate(chatgsi_llm_errors_total[5m]) * 60) or vector(0)",
    "object storage used of plan":
        "chatgsi_object_storage_used_bytes / chatgsi_object_storage_capacity_bytes",
}


class Prometheus:
    def __init__(self, url: str, enabled: bool = True, timeout: float = 4.0):
        self.url = url.rstrip("/")
        self.enabled = enabled and bool(url)
        self.timeout = timeout
        self.reachable = False

    def ping(self) -> bool:
        """Cheap liveness probe, run once per agent poll.

        Without it `reachable` stayed False until the first incident, so the
        status JSON reported Prometheus as unavailable when the truth was
        "never asked". A field that says `false` for both is worse than useless.
        """
        if not self.enabled:
            self.reachable = False
            return False
        try:
            r = httpx.get(f"{self.url}/-/healthy", timeout=self.timeout)
            self.reachable = r.status_code == 200
        except Exception:  # noqa: BLE001
            self.reachable = False
        return self.reachable

    def context(self) -> dict[str, Any]:
        if not self.enabled:
            return {}
        out: dict[str, Any] = {}
        try:
            with httpx.Client(timeout=self.timeout) as client:
                for label, expr in QUERIES.items():
                    try:
                        r = client.post(f"{self.url}/api/v1/query", data={"query": expr})
                        if r.status_code != 200:
                            continue
                        result = r.json().get("data", {}).get("result", [])
                        if result:
                            out[label] = _round(result[0]["value"][1])
                    except Exception:  # noqa: BLE001
                        continue
            self.reachable = bool(out)
        except Exception as exc:  # noqa: BLE001
            log.debug("prometheus context unavailable: %s", exc)
            self.reachable = False
        return out


def _round(raw: str) -> Any:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return raw
    if value == int(value):
        return int(value)
    return round(value, 4)
