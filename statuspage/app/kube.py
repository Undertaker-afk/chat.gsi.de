"""
Asking Kubernetes whether something is deliberately in motion.

This exists to tell two situations apart that look identical from outside:

    the chat interface is down because it broke
    the chat interface is down because somebody is deploying it

Both are a failing HTTP check. Only one is an incident, and calling a routine
rollout a "major outage" is the fastest way to teach people to ignore the status
page.

## What it does and does not touch

Read-only, and narrow: Deployments, StatefulSets, DaemonSets and Pods in one
namespace. It never writes, never lists secrets, and has no permission outside
`chat-gsi` (see the Role in k8s/80-status.yaml).

## Why this does not break the independence rule

AGENTS.md §7a says the status page must not depend on the stack it reports on.
The Kubernetes API server is not part of that stack -- it is the thing that would
still be up when the application is not -- and every call here is best-effort
behind a short timeout. If the API is unreachable the agent simply does not know
whether a rollout is happening, reports the outage it can actually see, and says
nothing about maintenance. Losing this degrades the *wording*, never the report.
"""

from __future__ import annotations

import json
import logging
import os
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount"
TIMEOUT_S = 4.0


@dataclass
class Rollout:
    """A workload that is not currently in its steady state."""

    kind: str
    name: str
    reason: str
    #: Workload names are matched loosely against monitor names, so this carries
    #: the words worth matching on rather than only the object name.
    words: list[str] = field(default_factory=list)


class Kubernetes:
    """
    Read-only view of what is in motion in one namespace.

    Constructed even when there is no service account -- `available` is False and
    every query returns empty. That keeps the agent's code free of "if we are in
    Kubernetes" branches, and means compose deployments simply never see
    maintenance classifications.
    """

    def __init__(self, namespace: str | None = None):
        self.namespace = namespace or os.environ.get("KUBE_NAMESPACE", "chat-gsi")
        self._token: str | None = None
        self._context: ssl.SSLContext | None = None
        self._host = os.environ.get("KUBERNETES_SERVICE_HOST")
        self._port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")

        try:
            with open(f"{SERVICE_ACCOUNT}/token", encoding="utf-8") as handle:
                self._token = handle.read().strip()
            self._context = ssl.create_default_context(cafile=f"{SERVICE_ACCOUNT}/ca.crt")
        except OSError:
            # Not running in a cluster, or no service account mounted. Both are
            # ordinary; neither is worth a warning on every poll.
            self._token = None

    @property
    def available(self) -> bool:
        return bool(self._token and self._host)

    def _get(self, path: str) -> dict | None:
        if not self.available:
            return None
        url = f"https://{self._host}:{self._port}{path}"
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._token}"})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S, context=self._context) as r:
                return json.load(r)
        except (urllib.error.URLError, OSError, ValueError) as err:
            # Including a 403 from a Role that was never applied. The agent must
            # keep reporting either way, so this is logged and swallowed.
            log.info("kubernetes read failed: %s (%s)", path, err)
            return None

    def rollouts(self) -> list[Rollout]:
        """
        Workloads that are mid-change right now.

        Deliberately generous about what counts. A Deployment is "in motion" when
        its observed generation lags its spec, or when the number of updated or
        available replicas does not match what is wanted -- which covers the whole
        window from `kubectl apply` to the new pod passing its readiness probe,
        and that window is exactly when the HTTP check fails.
        """
        found: list[Rollout] = []

        for kind, path in (
            ("Deployment", f"/apis/apps/v1/namespaces/{self.namespace}/deployments"),
            ("StatefulSet", f"/apis/apps/v1/namespaces/{self.namespace}/statefulsets"),
            ("DaemonSet", f"/apis/apps/v1/namespaces/{self.namespace}/daemonsets"),
        ):
            payload = self._get(path)
            if not payload:
                continue
            for item in payload.get("items", []):
                reason = _workload_reason(kind, item)
                if reason:
                    name = item.get("metadata", {}).get("name", "?")
                    found.append(Rollout(kind=kind, name=name, reason=reason, words=_words(name)))

        found.extend(self._pending_pods())
        return found

    def _pending_pods(self) -> list[Rollout]:
        """
        Pods that are not running yet.

        This is what catches an image still being pulled or a container still
        starting -- `ImagePullBackOff` and `ContainerCreating` are exactly the
        "currently building" state the report should mention rather than hide.
        """
        payload = self._get(f"/api/v1/namespaces/{self.namespace}/pods")
        if not payload:
            return []

        out: list[Rollout] = []
        for pod in payload.get("items", []):
            meta = pod.get("metadata", {})
            status = pod.get("status", {})
            name = meta.get("name", "?")

            if meta.get("deletionTimestamp"):
                out.append(Rollout("Pod", name, "wird beendet", _words(name)))
                continue

            phase = status.get("phase")
            if phase == "Pending":
                out.append(Rollout("Pod", name, "wartet auf Start", _words(name)))
                continue

            for container in status.get("containerStatuses", []) or []:
                waiting = (container.get("state") or {}).get("waiting")
                if waiting and waiting.get("reason"):
                    out.append(Rollout("Pod", name, str(waiting["reason"]), _words(name)))
                    break

        return out

    def rollout_for(self, component: str) -> Rollout | None:
        """
        The rollout that plausibly explains `component` being down, if any.

        Monitors are named for READERS ("Chat interface") and workloads for
        infrastructure ("frontend"), and those two vocabularies do not overlap --
        word matching alone never connects them, which is why WORKLOAD is an
        explicit map. It is the same shape as writer.py's IMPACT map and needs
        updating for the same reason: whenever a monitor is added.

        Word matching stays as the fallback, so a monitor somebody adds later
        without touching this file still has a chance of resolving.
        """
        rollouts = self.rollouts()
        if not rollouts:
            return None

        key = component.lower()
        for hint, workload in WORKLOAD.items():
            if hint in key:
                for rollout in rollouts:
                    if workload in rollout.name.lower():
                        return rollout

        wanted = _words(component)
        for rollout in rollouts:
            if any(word in rollout.words for word in wanted):
                return rollout
        return None


#: Monitor name (substring, lowercased) -> the workload that serves it.
#:
#: Without this "Chat interface" never resolves to the `frontend` Deployment, and
#: every deploy of the app reads as an outage -- which is the exact confusion this
#: module exists to remove.
WORKLOAD = {
    "chat": "frontend",
    "sign-in": "keycloak",
    "keycloak": "keycloak",
    "file storage": "seaweed",
    "storage": "seaweed",
    "dashboard": "grafana",
    "grafana": "grafana",
    "monitoring": "prometheus",
    "prometheus": "prometheus",
    "log": "loki",
    "database": "db",
    "crawler": "crawler",
}

#: Words that match everything and therefore distinguish nothing.
_NOISE = {"the", "der", "die", "das", "gsi", "chat", "service", "app", "http", "und"}


def _words(value: str) -> list[str]:
    cleaned = "".join(c.lower() if c.isalnum() else " " for c in value)
    return [w for w in cleaned.split() if len(w) > 2 and w not in _NOISE]


def _workload_reason(kind: str, item: dict) -> str | None:
    """
    Whether this workload is mid-change, from its status fields.

    The obvious checks -- `readyReplicas < spec.replicas`, `updatedReplicas <
    spec.replicas` -- DO NOT WORK for a RollingUpdate, and this was wrong in the
    first version. Measured on a real `rollout restart` of the frontend:

        spec.replicas=1  replicas=2  ready=1  updated=1  available=1  unavailable=1

    `maxSurge` brings up the new pod alongside the old one, so ready and updated
    both already equal the wanted count while the rollout is very much still
    running. The signals that actually move are the SURGE (`status.replicas`
    exceeding `spec.replicas`) and `unavailableReplicas`.
    """
    spec = item.get("spec", {})
    status = item.get("status", {})

    if status.get("observedGeneration", 0) < item.get("metadata", {}).get("generation", 0):
        return "Änderung wird ausgerollt"

    if kind == "DaemonSet":
        desired = status.get("desiredNumberScheduled", 0) or 0
        ready = status.get("numberReady", 0) or 0
        updated = status.get("updatedNumberScheduled", 0) or 0
        return "Rollout läuft" if ready < desired or updated < desired else None

    wanted = spec.get("replicas", 1) or 0
    if wanted == 0:
        # Scaled to zero deliberately -- `make down`, or a stateful workload being
        # replaced. Down on purpose is maintenance, not an outage.
        return "auf null skaliert"

    current = status.get("replicas", 0) or 0
    ready = status.get("readyReplicas", 0) or 0
    updated = status.get("updatedReplicas", 0) or 0
    unavailable = status.get("unavailableReplicas", 0) or 0

    # Surging: a new pod is up beside the old one.
    if current > wanted:
        return "Rollout läuft"
    # Something wanted is not serving -- covers Recreate, where the count drops
    # to zero before coming back, and a pod that has crashed during a rollout.
    if unavailable > 0 or ready < wanted:
        return "Rollout läuft"
    # Old pods still present under a replaced ReplicaSet.
    if updated < current:
        return "Rollout läuft"
    return None
