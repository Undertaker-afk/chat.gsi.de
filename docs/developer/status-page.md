# Status page

`uptime.lab` runs Uptime Kuma. `status.lab` is a small Python agent that turns its
data into a public status page with incident history, modelled on
githubstatus.com.

```
statuspage/app/
  kuma.py       read-only reader over Kuma's SQLite
  store.py      the agent's OWN SQLite: incidents, updates, monitor state
  agent.py      the poll loop and the state machine
  writer.py     the LLM narrator, with deterministic fallbacks
  prom.py       best-effort Prometheus context
  provision.py  creates the default monitors, via socket.io
  web.py        HTML, hand-rolled
  main.py       stdlib ThreadingHTTPServer
```

## Independence is the whole design

The one moment anybody opens a status page is the moment something is broken. So:

- no `depends_on`, no init container, no Service of the monitored stack in any
  readiness path, and **no connection to the application's Postgres** — incidents
  live in the agent's own SQLite;
- under compose it sits on its own `status` network, so its checks reach the app
  the way a user does rather than through a private network where a check can pass
  while every real request gets a 502 from Traefik;
- **`/healthz` answers "is the status page alive", never "is the stack healthy"** —
  otherwise Kubernetes would restart it during exactly the outage it exists to
  report.

### Two sources, deliberately

| Source | Answers |
|---|---|
| `/metrics` via API key | live status and response time — **now** |
| read-only SQLite | heartbeat history, 90-day bars — **the past** |

Not redundant. An API key unlocks `/metrics` and nothing else useful (verified:
`/api/status-page/heartbeat` times out, `/api/entry-page` carries no monitor
data), and `/metrics` is a *snapshot*. It cannot answer "was it slow for the last
two minutes"; the database can.

The one link to Kuma's internals is still a **read-only** mount of its SQLite:

```python
sqlite3.connect(f"file:{path}?mode=ro", uri=True)
```

`mode=ro` means the agent physically cannot write it. The database was originally
the *only* source, because every Kuma API route needs manual setup first — a
session, an API key, or a published status page — which defeats an agent that is
supposed to just run. An API key now exists, so live state comes from the
documented interface and the database keeps the job only it can do: history.

All queries `ORDER BY time DESC, id DESC`. Kuma's timestamps are second-resolution
and ties are common; without the tiebreaker, "the latest heartbeat" is
non-deterministic.

### One pod, two containers

On k3s they share a pod. That is the exception to one-process-per-container and it
buys something concrete: `local-path` is ReadWriteOnce, so a separate Deployment
could not mount Kuma's volume without pinning both to the same node anyway. The
agent still cannot write it.

## What the AI does

**The model writes prose. It never produces facts.**

Which component, when it started, how long it lasted, what the check reported, the
severity — all computed in code and either injected as a FACTS block or rendered
outside the model's text entirely. The model's job is to turn
`keycloak: connect ECONNREFUSED` into "signing in is unavailable".

That line is the whole design. A status page exists to be believed during an
incident, and one invented duration or fabricated root cause ends that
permanently. So every call has a deterministic fallback and the page labels which
one a reader is looking at with an **AI** badge.

`writer.py` holds the system prompt (five rules), an `IMPACT` map from monitor
names to user-facing consequences (`keycloak` → "signing in"), and four functions —
`incident_opened`, `escalated`, `resolved`, `all_clear` — each returning
`(text, ai_written)`.

> `_complete()` reads `content or reasoning_content`. gpt-oss returns
> `content: null` when the token budget goes entirely to reasoning; that threw,
> was swallowed as a failure, and short updates silently fell back to templates.
> Budgets were raised to 900/700/800/600 for the same reason.

## Three kinds of event

| Condition | Threshold | Result |
|---|---|---|
| Slow but answering | sustained **2 min** | `degraded` |
| Not answering | **3 min** | `outage` |
| Not answering **and** Kubernetes reports a rollout | 3 min | `maintenance` |

Explicit maintenance set in Uptime Kuma outranks all of it — somebody stated
their intent and no inference should override it.

### "Slow" has to be relative

These checks answer in 11–15 ms. A fixed "slower than 500 ms" would never fire on
a service that is degrading but still fast; a fixed "3× baseline" would fire on
13 ms → 40 ms, which nobody would call degradation. So it is **both**: 3× the
component's own 6-hour median **and** at least 250 ms, sustained over at least
three samples. `classify.py` holds the numbers.

The baseline is a *median*, not a mean — one 8-second stall during a deploy would
drag a mean up far enough to hide the very degradation this is meant to catch.

### Maintenance is not a milder outage

It gets its own severity, its own banner colour, and never counts as critical.
A routine `rollout restart` that renders as "Major System Outage" is the fastest
way to teach people that red means nothing.

## Reading Kubernetes

`kube.py`, read-only, one namespace, `get`/`list` on Deployments, StatefulSets,
DaemonSets and Pods. The Role is in `k8s/80-status.yaml`.

This does not break the independence rule (§7a): the API server is not part of
the stack being reported on — it is the thing still up when the application is
not — and every call is best-effort behind a 4-second timeout. Unreachable means
the agent cannot tell a rollout from a fault, so it says **outage**, which is the
honest answer. Losing it degrades the wording, never the report.

**The obvious rollout check does not work.** `readyReplicas < spec.replicas` and
`updatedReplicas < spec.replicas` are both false during a RollingUpdate, because
`maxSurge` brings the new pod up beside the old one. Measured on a real
`rollout restart` of the frontend:

```
spec.replicas=1  replicas=2  ready=1  updated=1  available=1  unavailable=1
```

The signals that actually move are the **surge** (`status.replicas` exceeding
`spec.replicas`) and `unavailableReplicas`. The first version used the obvious
checks and detected nothing at all.

**Monitor names and workload names share no vocabulary.** A monitor is called
"Chat interface" for readers; the workload is `frontend`. Word matching can never
bridge that, so `WORKLOAD` is an explicit map — the same shape as `writer.py`'s
`IMPACT` map, and needing an entry whenever a monitor is added.

## Decisions are code, not prompts

```python
OPEN_AFTER = 2         # consecutive failures before an incident is published
RESOLVE_AFTER = 3      # consecutive successes before it is resolved
DEGRADED_AFTER_S = 120 # sustained slowness before it is reported
OUTAGE_AFTER_S = 180   # downtime before it is an outage
CRITICAL_HINTS = …     # which components escalate severity
```

The thresholds are code because they are numbers somebody chose. What the model
decides is the **classification and the wording**: given a component, how long it
has failed, what the check said and what Kubernetes reports about that workload,
is this maintenance or an outage, and how should it read? That is the judgement,
and it is where a model belongs. A model deciding *whether* something is wrong
would make the page unreproducible and silent whenever the proxy is down.

Resolve is deliberately stricter: declaring victory early and re-opening reads far
worse than resolving late.

**Correlated failures fold into one incident.** When Postgres goes down the
frontend check fails moments later — that is one event to a reader, not two.
`store.find_open_for()` does the folding.

## "Operational" must mean "we checked"

A monitor that exists but has never produced a heartbeat has `status = None`.
Counting that as healthy would put a green banner up during the window when
nothing has been verified at all — the single worst thing a status page can do.

```python
reported = [m for m in monitors if m.status is not None]
if not monitors or not reported:
    overall = "unknown"
elif any(m.is_down for m in reported):
    overall = "major_outage" if "critical" in severities else "partial_outage"
elif len(reported) < len(monitors):
    overall = "partial_unknown"
else:
    overall = "operational"
```

`partial_unknown` renders as **Mostly Operational**, and the banner text names
which checks it is still waiting for. `daily_uptime()` returns `None` rather than
1.0 for a day with no data, so an un-monitored day is grey, not green.

## Provisioning

Five monitors are created on startup if they do not exist:

| Monitor | URL |
|---|---|
| Chat interface | `http://chat.lab/health` |
| Sign-in (Keycloak) | `http://keycloak.lab/realms/gsi/.well-known/openid-configuration` |
| File storage | `http://s3.lab/healthz` |
| Dashboards (Grafana) | `http://grafana.lab/api/health` |
| Monitoring (Prometheus) | `http://prometheus.lab/-/healthy` |

Set `KUMA_ADMIN_USER` / `KUMA_ADMIN_PASSWORD` in `.env`; leave them empty to skip
provisioning entirely. The Kuma admin account itself must be created once by hand
at `http://uptime.lab` — that is the only manual step.

**This is the ONE thing that writes to Kuma**, and it goes through the real
socket.io API rather than the database — writing another process's SQLite behind
its back is how you corrupt it. It is idempotent (matches on name), only ever
*adds*, and never resurrects a monitor somebody deleted or paused on purpose. It
retries on a background thread because Kuma needs about a minute after a cold
start before its socket accepts a login.

### The checks target `.lab` hostnames, never Service names

A check against `http://frontend:3000` would pass while every real user got a 502
from Traefik. That is the outage nobody would notice.

### Monitor names are public

The name is what appears on the status page and inside incident text. Name them
for readers ("Sign-in"), not for infrastructure. `writer.py` maps common names to
user-facing impact; anything unrecognised is passed through as-is.

## Routes

| Route | |
|---|---|
| `/` | the status page |
| `/history` | incidents grouped by month |
| `/api/status.json` | machine-readable: overall, components, sources |
| `/healthz` | is *this* alive — deliberately independent of Kuma |

`web.py` builds plain strings with `esc()` on every interpolation. Incident text is
model-generated and monitor names are user-supplied; both are untrusted.

## Configuration

```bash
STATUS_POLL_SECONDS=30
STATUS_AI_ENABLED=true          # false forces the deterministic path
STATUS_MODEL=                   # defaults to UTILITY_MODEL
STATUS_PROMETHEUS_URL=http://prometheus:9090   # best-effort context only
KUMA_ADMIN_USER=admin
KUMA_ADMIN_PASSWORD=…
```

Prometheus is optional and `ping()`ed each poll so `sources.prometheus` reports
honest reachability. It is *expected* to be unreachable during the outages this
page exists to report — the agent works without it.

## Testing it

```bash
make -f k8s/Makefile.k8s status-drill        # ~12-18 min, cleans up after itself
```

The drill (`deploy/status-drill.py` + `statuspage/app/drilltools.py`) stands up a
throwaway target, points a test monitor at it, and drives it through a real
degraded → outage → maintenance sequence, asserting the right kind of incident
opens each time. It uses real signal — Kuma actually observes the target, the
running agent actually classifies it, the writer actually narrates it — rather
than injecting heartbeats, so a pass exercises the whole loop and not just
`classify()`. Full details, including how the target's two independent paths
(`/` monitored, `/ready` readiness) separate outage from maintenance, are in
[Testing](testing.md#the-status-page).
