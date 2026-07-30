"""Structured logging for the crawler.

One JSON object per line on stdout, matching what the frontend emits from
frontend/src/lib/server/log.ts. Promtail ships both to Loki and Grafana parses
them with the same `| json`, so a crawl and the request that triggered it can be
read in one query.

Text output stays available (LOG_FORMAT=text) because `make crawl` in a terminal
is a real workflow and JSON is the wrong shape for a human watching a progress
log scroll past.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

#: Fields the formatter must not copy out of the LogRecord: they are either
#: internal to logging or already emitted under a different name.
# Python calls them WARNING and CRITICAL; the frontend logger calls them warn and
# fatal. Two spellings of one level is not a cosmetic problem: `level` is promoted
# to a Loki LABEL, so it splits every warning graph into two series that each look
# like half the real rate, and a `level="warn"` filter silently misses the
# crawler. Normalised here, at the only place that can be authoritative.
_LEVELS = {
    "WARNING": "warn",
    "CRITICAL": "fatal",
}

_RESERVED = {
    "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
    "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
    "pathname", "process", "processName", "relativeCreated", "stack_info",
    "thread", "threadName", "taskName",
}


class JsonFormatter(logging.Formatter):
    """Render a LogRecord as one JSON line.

    Extras passed as `log.info("...", extra={"source": "wiki"})` become
    top-level fields, which is what makes a Grafana query like
    `{app="crawler"} | json | source="wiki"` possible without regex.
    """

    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": _LEVELS.get(record.levelname, record.levelname.lower()),
            "msg": record.getMessage(),
            "logger": record.name,
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                out[key] = value
        if record.exc_info:
            out["err"] = self.formatException(record.exc_info)
        # default=str so a datetime or a Path in an extra cannot crash logging
        # itself -- a telemetry bug must never take down a crawl.
        return json.dumps(out, default=str, ensure_ascii=False)


def configure(level: str | None = None) -> None:
    handler = logging.StreamHandler(sys.stdout)
    if os.environ.get("LOG_FORMAT", "json").lower() == "text":
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S"))
    else:
        handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    # Replace rather than add: basicConfig may already have run, and two handlers
    # means every line twice, which in Loki means every count doubled.
    root.handlers[:] = [handler]
    root.setLevel((level or os.environ.get("LOG_LEVEL", "INFO")).upper())
