"""Starting a crawl as its own Kubernetes Job.

## Why the tick stopped doing the crawling itself

`crawler tick` used to claim the queue AND run every crawl inline, while the
CronJob carried `concurrencyPolicy: Forbid`. Those two facts together mean a long
crawl blocks the scheduler: a first full crawl of www ran for three hours, and
for those three hours no tick could start, so nothing could claim the queue.
Requests an admin made in the UI sat untouched, the dashboard's "oldest queued"
climbed without bound, and `kubectl get cronjob` showed a perfectly healthy
schedule the whole time.

Splitting them fixes it at the root. The tick now reaps, claims, dispatches and
exits in well under a second, so `Forbid` never has anything to forbid, and each
crawl runs in its own Job for as long as it needs.

## What still stops two crawls of one source

Not the CronJob policy -- the database, which is where it always belonged:

  * `claim_crawl_requests()` claims with UPDATE ... RETURNING, so two ticks
    cannot take the same request;
  * `due_schedules()` excludes sources with a run already `running`, and the
    tick advances the schedule before dispatching.

Concurrency is therefore bounded by the number of sources, not by how often the
timer fires.

## Outside Kubernetes

`available` is False without a service account, and the tick then crawls inline
exactly as it used to. That keeps `docker compose` and a local checkout working
with no Kubernetes branch in the caller: same code, one fewer capability.
"""

from __future__ import annotations

import json
import logging
import os
import ssl
import time
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount"
TIMEOUT_S = 8.0

#: The CronJob whose jobTemplate every dispatched crawl is cloned from. Cloning
#: rather than templating a spec here means image, env, volumes, resources and
#: service account are defined in exactly one place (k8s/51-crawler-cron.yaml),
#: and a crawl Job cannot drift from the tick that starts it.
SOURCE_CRONJOB = os.environ.get("CRAWLER_CRONJOB", "crawler-tick")

#: Dispatched Jobs clean themselves up. Without this a source crawled every
#: 5 minutes would leave a Job object behind for every run, forever.
TTL_AFTER_FINISHED_S = 86400


class Dispatcher:
    """Creates one Job per crawl, cloned from the tick's own CronJob template."""

    def __init__(self, namespace: str | None = None):
        self.namespace = (namespace or os.environ.get("KUBE_NAMESPACE")
                          or _namespace_from_service_account() or "chat-gsi")
        self._token: str | None = None
        self._context: ssl.SSLContext | None = None
        self._host = os.environ.get("KUBERNETES_SERVICE_HOST")
        self._port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")

        try:
            with open(f"{SERVICE_ACCOUNT}/token", encoding="utf-8") as handle:
                self._token = handle.read().strip()
            self._context = ssl.create_default_context(cafile=f"{SERVICE_ACCOUNT}/ca.crt")
        except OSError:
            # No service account: not in a cluster, or deliberately not granted
            # one. Both are ordinary and the caller falls back to crawling inline.
            self._token = None

    @property
    def available(self) -> bool:
        return bool(self._token and self._host)

    # --- the one thing this does ---------------------------------------------

    def dispatch(self, *, slug: str, args: list[str]) -> str | None:
        """Start a crawl Job. Returns its name, or None if it could not.

        Returning None is not fatal anywhere: the caller crawls inline instead,
        which is slower for the queue but always correct.
        """
        template = self._job_template()
        if template is None:
            return None

        name = f"crawl-{_dns_safe(slug)}-{int(time.time())}"
        spec = json.loads(json.dumps(template))  # deep copy; we mutate it
        spec.setdefault("spec", {})["ttlSecondsAfterFinished"] = TTL_AFTER_FINISHED_S
        # A dispatched crawl must not be retried by Kubernetes: a half-finished
        # crawl leaves a `running` row that the next tick reaps deliberately, and
        # a silent retry would start a second crawl of the same source behind the
        # database's back -- the exact thing the SQL claim exists to prevent.
        spec["spec"]["backoffLimit"] = 0

        containers = spec["spec"].get("template", {}).get("spec", {}).get("containers", [])
        if not containers:
            log.warning("cronjob %s has no containers to clone", SOURCE_CRONJOB)
            return None
        containers[0]["args"] = args

        body = {
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": name,
                "namespace": self.namespace,
                "labels": {"app": "crawler", "crawler/source": _dns_safe(slug),
                           "crawler/dispatched-by": "tick"},
            },
            "spec": spec["spec"],
        }
        # An inherited selector belongs to the CronJob's own Jobs and makes the
        # create fail on a clone. The pod template's LABELS, however, must be
        # kept: promtail ships logs and every Grafana panel selects
        # {app="crawler"}, so dropping them made dispatched crawls invisible --
        # crawls running, pages climbing, and "No data" in all three log panels.
        # Only the controller-managed labels are stripped; the meaningful ones
        # stay, plus the source so one crawl's logs can be isolated.
        body["spec"].pop("selector", None)
        labels = (body["spec"].setdefault("template", {})
                              .setdefault("metadata", {})
                              .setdefault("labels", {}))
        for managed in ("controller-uid", "job-name",
                        "batch.kubernetes.io/controller-uid",
                        "batch.kubernetes.io/job-name"):
            labels.pop(managed, None)
        labels.setdefault("app", "crawler")
        labels["crawler/source"] = _dns_safe(slug)

        created = self._post(f"/apis/batch/v1/namespaces/{self.namespace}/jobs", body)
        if created is None:
            return None
        log.info("dispatched crawl of %s as job %s", slug, name)
        return name

    # --- plumbing -------------------------------------------------------------

    def _job_template(self) -> dict | None:
        cronjob = self._get(
            f"/apis/batch/v1/namespaces/{self.namespace}/cronjobs/{SOURCE_CRONJOB}")
        if cronjob is None:
            return None
        template = cronjob.get("spec", {}).get("jobTemplate")
        if not template:
            log.warning("cronjob %s has no jobTemplate", SOURCE_CRONJOB)
            return None
        return template

    def _get(self, path: str) -> dict | None:
        return self._call("GET", path, None)

    def _post(self, path: str, body: dict) -> dict | None:
        return self._call("POST", path, body)

    def _call(self, method: str, path: str, body: dict | None) -> dict | None:
        if not self.available:
            return None
        request = urllib.request.Request(
            f"https://{self._host}:{self._port}{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self._token}",
                     "Accept": "application/json",
                     **({"Content-Type": "application/json"} if body is not None else {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S,
                                        context=self._context) as response:
                return json.load(response)
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:300]
            log.warning("kubernetes %s %s failed: HTTP %d %s", method, path, err.code, detail)
            return None
        except (urllib.error.URLError, OSError, ValueError) as err:
            log.warning("kubernetes %s %s failed: %s", method, path, err)
            return None


def _namespace_from_service_account() -> str | None:
    try:
        with open(f"{SERVICE_ACCOUNT}/namespace", encoding="utf-8") as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def _dns_safe(value: str) -> str:
    """Job names are DNS labels: lowercase alphanumerics and dashes, 63 max."""
    safe = "".join(c if c.isalnum() else "-" for c in value.lower()).strip("-")
    return (safe or "source")[:30]
