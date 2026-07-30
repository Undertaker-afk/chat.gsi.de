"""Entry point: the agent thread plus a small HTTP server.

Deliberately dependency-light -- stdlib HTTP, stdlib SQLite, httpx only for the
two outbound calls. This service's whole value is being up when nothing else is,
so it has as little to go wrong as possible: no ASGI server, no template engine,
no database driver, no connection to the application's Postgres.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .agent import Agent
from .kube import Kubernetes
from .kuma_api import KumaApi
from .kuma import Kuma
from .prom import Prometheus
from .store import Store
from . import web

log = logging.getLogger("statuspage")


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def env_bool(key: str, default: bool) -> bool:
    raw = env(key)
    return default if not raw else raw.lower() in ("1", "true", "yes", "on")


def env_float(key: str, default: float) -> float:
    try:
        return float(env(key) or default)
    except ValueError:
        return default


class Handler(BaseHTTPRequestHandler):
    agent: Agent
    kuma: Kuma
    store: Store

    server_version = "gsi-statuspage"

    def log_message(self, fmt: str, *args) -> None:
        # Deliberately silent. The readiness probe hits /healthz every 10s and the
        # page is polled by browsers, so a line per request floods Loki for no
        # signal. This also silences the stdlib's own log_error (it routes through
        # here), which is fine: the events worth keeping -- incidents, and any
        # unhandled request failure (logged via log.exception in do_GET) -- do not
        # go through this path.
        return

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            if path == "/":
                self._html(self._current())
            elif path == "/history":
                self._html(web.render_history(self.store.recent(200)))
            elif path == "/api/status.json":
                snap = self.agent.snapshot()
                self._send(200, "application/json; charset=utf-8",
                           web.status_json(snap, self._uptimes(snap)))
            elif path == "/healthz":
                # Deliberately does NOT depend on Kuma: this answers "is the
                # status page itself alive", and a status page that reports
                # itself unhealthy because the thing it watches is down would be
                # useless exactly when it is needed.
                self._send(200, "text/plain; charset=utf-8", "ok\n")
            else:
                self._send(404, "text/plain; charset=utf-8", "not found\n")
        except Exception:  # noqa: BLE001
            log.exception("request failed: %s", self.path)
            self._send(500, "text/plain; charset=utf-8", "internal error\n")

    def _current(self) -> str:
        snap = self.agent.snapshot()
        daily = {m.id: self.kuma.daily_uptime(m.id, 90) for m in snap["monitors"]}
        return web.render_current(snap, daily, self._uptimes(snap))

    def _uptimes(self, snap) -> dict[int, float | None]:
        return {m.id: self.kuma.overall_uptime(m.id, 90) for m in snap["monitors"]}

    def _html(self, body: str) -> None:
        self._send(200, "text/html; charset=utf-8", body)

    def _send(self, code: int, content_type: str, body: str) -> None:
        payload = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


def main() -> int:
    logging.basicConfig(
        level=env("LOG_LEVEL", "INFO").upper(),
        stream=sys.stdout,
        format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    )
    # httpx logs one INFO line per outbound call; the Prometheus ping alone fires
    # every poll, which floods Loki with no signal. Keep its warnings and errors.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    kuma = Kuma(env("KUMA_DB", "/kuma/kuma.db"))
    store = Store(env("STATUS_DB", "/data/status.db"))
    prom = Prometheus(env("PROMETHEUS_URL", "http://prometheus:9090"),
                      enabled=env_bool("PROMETHEUS_ENABLED", True))

    from .writer import Writer
    writer = Writer(
        base_url=env("LLM_BASE_URL", "http://192.168.50.1:8080/api/v1"),
        api_key=env("LLM_API_KEY"),
        model=env("STATUS_MODEL", env("UTILITY_MODEL", "llmbot.gpt-oss-120b")),
        enabled=env_bool("STATUS_AI_ENABLED", True),
    )
    if not writer.enabled:
        log.warning("AI writer disabled (no LLM_API_KEY, or STATUS_AI_ENABLED=false) "
                    "-- incidents will use deterministic summaries")

    # Create the default checks if Kuma has none. Runs on its own thread and
    # retries, because on a cold start Kuma needs about a minute before its
    # socket accepts a login -- and the agent should not wait for that.
    from .provision import provision_when_ready
    provision_when_ready(
        env("KUMA_URL", "http://127.0.0.1:3001"),
        env("KUMA_ADMIN_USER"),
        env("KUMA_ADMIN_PASSWORD"),
    )

    # Kuma's own API, for live status and response time. Optional: without a key
    # the agent reads everything from the database exactly as it did before.
    api = KumaApi(env("KUMA_URL", "http://127.0.0.1:3001"), env("KUMA_API_KEY"))
    if not api.configured:
        log.info("no KUMA_API_KEY set -- live status will come from the database only")

    # Read-only Kubernetes, to tell a deployment apart from a fault. Optional in
    # the same way: without it a rollout simply reads as an outage, which is the
    # honest answer when we cannot tell the difference.
    kube = Kubernetes(env("KUBE_NAMESPACE", "chat-gsi"))
    if not kube.available:
        log.info("no kubernetes service account -- maintenance cannot be detected")

    agent = Agent(kuma, store, writer, prom,
                  interval=env_float("STATUS_POLL_SECONDS", 30),
                  api=api, kube=kube)
    agent.start()

    Handler.agent, Handler.kuma, Handler.store = agent, kuma, store
    port = int(env("PORT", "3003"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)

    def shutdown(*_):
        log.info("shutting down")
        agent.stop()
        httpd.shutdown()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    log.info("status page on :%d, reading kuma at %s", port, kuma.db_path)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
