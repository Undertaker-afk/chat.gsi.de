"""The agent loop: watch Kuma, decide, publish.

The decisions are made HERE, in code, and only the wording is delegated to the
model (see writer.py). That split is the whole design: an LLM deciding whether
something counts as an outage would be unpredictable in exactly the situation
where predictability matters.

State machine per monitor:

    up ──(down for OPEN_AFTER beats)──> down ──(up for RESOLVE_AFTER beats)──> up
                    │                                      │
              open incident                          resolve incident

The two thresholds exist because monitoring is noisy. A single failed ping is
usually a dropped packet, not an outage; publishing an incident for it trains
people to ignore the status page, which is worse than having none. Equally, a
service that flaps up for one beat is not recovered, so recovery needs to be
sustained too.

Correlated failures fold into ONE incident: when Postgres goes down the frontend
health check fails moments later, and a reader experiences one event, not two.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

from .classify import classify
from .kube import Kubernetes
from .kuma import Kuma, Monitor
from .kuma_api import KumaApi
from .prom import Prometheus
from .store import Store
from .writer import Writer, user_impact

log = logging.getLogger(__name__)

#: Consecutive failing beats before an incident is published. With Kuma's
#: default 60 s interval this is two minutes of sustained failure.
OPEN_AFTER = 2
#: Consecutive healthy beats before an incident is resolved. Higher than
#: OPEN_AFTER on purpose: declaring victory early and having to re-open reads far
#: worse than resolving a few minutes late.
RESOLVE_AFTER = 3

#: Monitors whose failure means the product is unusable, not merely degraded.
CRITICAL_HINTS = ("frontend", "chat", "keycloak", "auth", "postgres", "db", "database")


class Agent:
    def __init__(self, kuma: Kuma, store: Store, writer: Writer, prom: Prometheus,
                 interval: float = 30.0, api: KumaApi | None = None,
                 kube: Kubernetes | None = None):
        self.kuma = kuma
        self.store = store
        self.writer = writer
        self.prom = prom
        #: Live state from Kuma's own API. Optional: without a key the agent
        #: falls back to the database entirely, which is how it ran before.
        self.api = api
        #: Read-only Kubernetes. Optional in the same way -- without it a rollout
        #: is indistinguishable from a fault, and the agent says "outage",
        #: which is the honest answer when it cannot tell.
        self.kube = kube
        self.interval = interval
        self._stop = threading.Event()
        self.last_poll: datetime | None = None
        self.kuma_seen = False

    # --- lifecycle ------------------------------------------------------------

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self._run, name="status-agent", daemon=True)
        t.start()
        return t

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.poll()
            except Exception:  # noqa: BLE001
                # The agent must outlive every individual failure. A status page
                # that stops updating because one poll threw is the failure mode
                # this whole service exists to avoid.
                log.exception("agent poll failed")

    # --- one pass -------------------------------------------------------------

    def poll(self) -> None:
        if not self.kuma.available():
            log.debug("kuma database not readable yet")
            return

        monitors = self.kuma.monitors()
        if not monitors:
            return

        self.kuma_seen = True
        self.last_poll = datetime.now(timezone.utc)
        self.prom.ping()

        live = self.api.monitors() if self.api else {}
        rollouts = self.kube.rollouts() if self.kube else []

        down = [m for m in monitors if m.is_down and m.streak >= OPEN_AFTER]
        healthy = [m for m in monitors if m.is_up and m.streak >= RESOLVE_AFTER]

        for m in down:
            self._handle_down(m, live.get(m.name), rollouts)
        self._handle_recovery(healthy, monitors)

        # Slow-but-up is a separate pass: these monitors are not in `down` at all,
        # so nothing above would ever look at them.
        for m in monitors:
            if m.is_up:
                self._handle_slow(m)

        for m in monitors:
            self.store.remember(m.id, m.name, "down" if m.is_down else "up")

    # --- transitions ----------------------------------------------------------

    def _handle_down(self, monitor: Monitor, live: Any = None,
                     rollouts: list[Any] | None = None) -> None:
        if self.store.find_open_for(monitor.name):
            return  # already reported

        beats = self.kuma.recent_beats(monitor.id, limit=60)
        rollout = self.kube.rollout_for(monitor.name) if self.kube else None
        verdict = classify(
            component=monitor.name,
            beats=beats,
            detail=monitor.message or "no detail reported",
            rollout=f"{rollout.kind} {rollout.name}: {rollout.reason}" if rollout else None,
            in_maintenance=bool(live and live.in_maintenance),
        )

        # Below the 3-minute threshold. Most blips resolve inside it, and
        # reporting them teaches people to ignore the page.
        if not verdict.is_incident:
            return

        open_incidents = self.store.open_incidents()
        facts = self._facts(monitor)
        facts["duration"] = f"{max(1, verdict.duration_s // 60)} min"
        if verdict.rollout:
            facts["kubernetes"] = verdict.rollout

        if open_incidents:
            # Fold into the most recent open incident rather than opening a
            # second one: one user-visible event, one entry.
            incident = open_incidents[0]
            merged = self.store.add_components(incident.id, [monitor.name])
            # A second component going down inside the same rollout is still the
            # rollout, not an outage -- only escalate when something is failing
            # for a reason we cannot attribute to maintenance.
            if not (verdict.kind == "maintenance" and incident.severity == "maintenance"):
                self.store.set_severity(incident.id, self._severity(merged))
            facts["new_components"] = [monitor.name]
            facts["all_components"] = merged
            body, ai = self.writer.incident_escalated(facts)
            self.store.add_update(incident.id, "identified", body, ai)
            log.info("incident %d now also covers %s", incident.id, monitor.name)
            return

        # Maintenance is a different kind of event, not a milder outage: it gets
        # its own wording and never counts as critical, because a planned restart
        # that reads as "major outage" is what makes people distrust the page.
        if verdict.kind == "maintenance":
            title, body, ai = self.writer.maintenance_opened(facts)
            severity = "maintenance"
            status = "maintenance"
        else:
            title, body, ai = self.writer.incident_opened(facts)
            severity = self._severity([monitor.name])
            status = "investigating"

        incident_id = self.store.open_incident(
            title=title, summary=body, severity=severity,
            components=[monitor.name], ai_written=ai)
        self.store.add_update(incident_id, status, body, ai)
        log.info("opened %s %d: %s", verdict.kind, incident_id, title)

    def _handle_slow(self, monitor: Monitor) -> None:
        """
        A component that answers, but slowly, for longer than DEGRADED_AFTER_S.

        Deliberately does nothing when an incident for this component is already
        open: something that is down is not also 'slow', and reporting both would
        double-count one problem.
        """
        if self.store.find_open_for(monitor.name):
            return

        beats = self.kuma.recent_beats(monitor.id, limit=120)
        verdict = classify(
            component=monitor.name,
            beats=beats,
            detail=monitor.message or "responding slowly",
            rollout=None,
            in_maintenance=False,
        )
        if verdict.kind != "degraded":
            return

        facts = self._facts(monitor)
        facts["duration"] = f"{max(1, verdict.duration_s // 60)} min"
        facts["response_time"] = f"{verdict.response_ms:.0f} ms"
        facts["normal_response_time"] = f"{verdict.baseline_ms:.0f} ms"

        title, body, ai = self.writer.degradation_opened(facts)
        incident_id = self.store.open_incident(
            title=title, summary=body, severity="degraded",
            components=[monitor.name], ai_written=ai)
        self.store.add_update(incident_id, "degraded", body, ai)
        log.info("opened degradation %d: %s (%s vs %s baseline)",
                 incident_id, title, facts["response_time"], facts["normal_response_time"])

    def _handle_recovery(self, healthy: list[Monitor], all_monitors: list[Monitor]) -> None:
        healthy_names = {m.name for m in healthy}
        still_down = {m.name for m in all_monitors if m.is_down}
        by_name = {m.name: m for m in all_monitors}

        for incident in self.store.open_incidents():
            # Every component must be healthy AND none of them still failing.
            # Checked separately because a monitor deleted from Kuma mid-incident
            # would otherwise leave the incident open forever.
            covered = set(incident.components)
            if covered & still_down:
                continue
            if not covered.issubset(healthy_names | (covered - {m.name for m in all_monitors})):
                continue

            # A degradation is reported on an UP monitor, so "up" is NOT recovery
            # for it -- the slowness has to have actually cleared. Without this the
            # incident resolves one poll after _handle_slow opens it, _handle_slow
            # re-opens it the same poll, and it flaps open/resolve forever.
            if incident.severity == "degraded" and self._still_slow(incident, by_name):
                continue

            facts = {
                "components": incident.components,
                "user impact": [user_impact(c) for c in incident.components],
                "started_at": _human(incident.opened_at),
                "duration_minutes": _minutes_since(incident.opened_at),
                "severity": incident.severity,
            }
            body, ai = self.writer.incident_resolved(facts)
            self.store.resolve(incident.id, body, ai)
            log.info("resolved incident %d after %s minutes",
                     incident.id, facts["duration_minutes"])

            # The "all systems operational" note, published only when NOTHING is
            # left failing -- not once per resolved incident, which would announce
            # all-clear while another outage is still running. Filed under
            # "all_clear" rather than "resolved" so the incident does not show
            # two Resolved headings saying much the same thing.
            if not still_down and not self.store.open_incidents():
                note, note_ai = self.writer.all_clear({
                    "recovered_components": incident.components,
                    "monitored_components": [m.name for m in all_monitors],
                    "duration_minutes": facts["duration_minutes"],
                })
                self.store.add_update(incident.id, "all_clear", note, note_ai)

    def _still_slow(self, incident: Any, by_name: dict[str, Monitor]) -> bool:
        """Whether any component of a degradation incident is still slow.

        Re-uses classify() rather than a bespoke check so "recovered" means
        exactly the negation of "would open a degradation now": the moment one
        fast beat lands, sustained_slow walks back to it and returns ok.
        """
        for name in incident.components:
            monitor = by_name.get(name)
            if monitor is None or not monitor.is_up:
                continue
            verdict = classify(
                component=name,
                beats=self.kuma.recent_beats(monitor.id, limit=120),
                detail=monitor.message or "",
                rollout=None,
                in_maintenance=False,
            )
            if verdict.kind == "degraded":
                return True
        return False

    # --- context --------------------------------------------------------------

    def _facts(self, monitor: Monitor) -> dict[str, Any]:
        beats = self.kuma.recent_beats(monitor.id, limit=8)
        facts: dict[str, Any] = {
            "component": monitor.name,
            "user impact": user_impact(monitor.name),
            "check type": monitor.type,
            "started_at": _human(monitor.last_beat.isoformat() if monitor.last_beat else None),
            "consecutive failed checks": monitor.streak,
            "error reported by the check": (monitor.message or "none")[:200],
            # `state`, not `status`: the model gets "down at 12:10", not "0 at 12:10".
            "recent check results": [f"{b['state']} at {b['at']}" for b in beats[:5]],
            "components": [monitor.name],
        }
        # Grafana/Prometheus is optional and best-effort by design: this service
        # must keep working when the monitored stack is down, which is exactly
        # when Prometheus is likely unreachable too.
        extra = self.prom.context()
        if extra:
            facts["additional signals from monitoring"] = extra
        return facts

    def _severity(self, components: list[str]) -> str:
        """
        How bad an outage is, by what it touches.

        Only ever called for genuine outages. `maintenance` and `degraded` are
        set directly at their call sites, because neither is a severity of an
        outage -- they are different kinds of event.
        """
        joined = " ".join(components).lower()
        critical = any(h in joined for h in CRITICAL_HINTS)
        if critical and len(components) > 1:
            return "critical"
        if critical:
            return "major"
        return "major" if len(components) > 2 else "minor"

    # --- for the web layer ----------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        monitors = self.kuma.monitors()
        open_incidents = self.store.open_incidents()

        # "Operational" has to mean "we checked and it was fine", never "we have
        # not checked". A monitor that exists but has never produced a heartbeat
        # has status None, and treating that as healthy would put a green banner
        # up during the window where nothing has been verified at all -- the
        # single worst thing a status page can do.
        reported = [m for m in monitors if m.status is not None]

        severities = [i.severity for i in open_incidents]

        if not monitors or not reported:
            overall = "unknown"
        elif any(m.is_down for m in reported):
            # Maintenance outranks the raw down-ness. A component that is down
            # solely because it is being deployed must not paint the page red --
            # doing so is what teaches people that red means nothing.
            if severities and all(s == "maintenance" for s in severities):
                overall = "maintenance"
            elif "critical" in severities:
                overall = "major_outage"
            else:
                overall = "partial_outage"
        elif "degraded" in severities:
            # Everything answers, something is slow. Not an outage; still worth
            # a banner, because "why is it sluggish" is the question being asked.
            overall = "degraded"
        elif len(reported) < len(monitors):
            # Some checks have run and passed, others have never run. Not an
            # outage, but not a clean bill of health either.
            overall = "partial_unknown"
        else:
            overall = "operational"

        return {
            "overall": overall,
            "monitors": monitors,
            "open_incidents": open_incidents,
            "last_poll": self.last_poll,
            "kuma_seen": self.kuma_seen,
            "ai_available": self.writer.available,
            "prometheus": self.prom.reachable,
            "monitors_pending": [m.name for m in monitors if m.status is None],
        }


def _human(iso: str | None) -> str:
    if not iso:
        return "just now"
    try:
        return datetime.fromisoformat(iso).strftime("%Y-%m-%d %H:%M UTC")
    except ValueError:
        return str(iso)


def _minutes_since(iso: str) -> int:
    try:
        started = datetime.fromisoformat(iso)
        return max(1, round((datetime.now(timezone.utc) - started).total_seconds() / 60))
    except ValueError:
        return 1
