# Operating notes for AI agents: chat.gsi.de on the lab cluster

Read this before running anything. It describes a two-machine setup where the
repo lives on one box and the workload runs on another. Several things that look
like misconfiguration are deliberate and documented here — check this file before
"fixing" them.

---

## 1. Topology

```
   Fedora dev box                                  Ubuntu 24.04 node
   192.168.50.112 (eno2)  ──── 192.168.50.1 ────   192.168.50.119 (eno1)
   - the git repo                  gateway         - k3s server, single node
   - podman + registry :5000       + LLM proxy     - runs every workload
   - kubectl client                                - hostname flo-latitudee5450
```

- **Never run workloads on the Fedora box.** It is a client: repo, image builds,
  registry, `kubectl`. Nothing else. That includes `npm run build`, `npm run
  check` and test runs — the Containerfile builds the app, and the box has ~2 GB
  free RAM, so a local build overloads it. Verify against the cluster
  (`kubectl exec`, `curl http://chat.lab`), not locally.
- **The gateway `192.168.50.1` is also the GSI LLM proxy** on port 8080, path
  prefix `/api/v1` (not `/v1`). Pods reach it by NAT through the node; no special
  config needed.
- Isolated lab subnet. Do not add TLS, NetworkPolicies, or auth hardening unless
  asked — it is deliberately open.

## 2. Access

### kubectl (preferred — use this for almost everything)

From the Fedora box. `KUBECONFIG=~/.kube/lab-config` is exported in `~/.bashrc`,
context is named `lab`.

```bash
kubectl get nodes                       # sanity check
kubectl -n chat-gsi get pods,svc,ingress,pvc
```

If a command returns `Unauthorized` as raw JSON, you almost certainly hit
`https://192.168.50.119:6443` with curl instead of kubectl. That 401 is the API
server behaving correctly, not a fault. To health-check the endpoint use
`kubectl get --raw /healthz`, which returns `ok`.

### SSH to the node (only when kubectl cannot do the job)

```bash
ssh flo@192.168.50.119        # password: flo
```

> The password is in this file because the subnet is isolated and the node is
> rebuildable. If this repo ever leaves the lab, remove this line and use
> `ssh-copy-id flo@192.168.50.119` instead.

SSH is needed for exactly four things:

1. `sudo systemctl {status,restart} k3s` and `sudo journalctl -u k3s -f`
2. Editing `/etc/rancher/k3s/registries.yaml`
3. Inspecting `/var/lib/rancher/k3s/storage/` (where PVC data actually lives)
4. `sudo /usr/local/bin/k3s-uninstall.sh` — full teardown, see §8

Everything else — logs, exec, port-forward, describe — goes through kubectl.
Do not SSH in to run `k3s kubectl`; use the local client.

## 3. Images

There is no shared container registry. Images move Fedora → node through a plain
HTTP registry running under podman on the Fedora box.

```bash
podman push --tls-verify=false 192.168.50.112:5000/<name>:dev
```

- `--tls-verify=false` is **required** — the registry is HTTP, matching the
  `http://` endpoint in the node's `/etc/rancher/k3s/registries.yaml`. Do not
  "fix" this by adding certs.
- Registry container is `registry` with `--restart=always`. If pushes fail with
  connection refused: `podman start registry` on Fedora.
- Tags are mutable (`:dev`), so every Deployment using them sets
  `imagePullPolicy: Always`. Pushing alone changes nothing — you must also
  `kubectl rollout restart`.
- Check what is in the registry: `curl -s http://192.168.50.112:5000/v2/_catalog`

## 4. The loop

All targets run from the repo root.

| Task | Command |
|---|---|
| Code changed | `make -f k8s/Makefile.k8s restart` |
| `.env`, `db/migrations/`, `realm-gsi.json`, `s3.json` changed | `make -f k8s/Makefile.k8s config` then `restart` |
| Manifests in `k8s/` changed | `make -f k8s/Makefile.k8s deploy` |
| First run / from scratch | `make -f k8s/Makefile.k8s up` |
| Logs | `kubectl -n chat-gsi logs -f deployment/frontend` |
| Free RAM, keep data | `make -f k8s/Makefile.k8s down` |
| Crawl | `make -f k8s/Makefile.k8s crawl` |
| Dashboards or scrape config changed | `config` then `restart-observability` |
| See the raw exposition | `make -f k8s/Makefile.k8s metrics` |
| New migration | `make -f k8s/Makefile.k8s migrate FILE=db/migrations/0XX_….sql` |
| Run the scheduler now | `make -f k8s/Makefile.k8s tick` |
| Drill the status page (degraded/outage/maintenance) | `make -f k8s/Makefile.k8s status-drill` (§7a) |

Config lands as a Secret (`chat-gsi-env`, generated from `.env`) and eight
ConfigMaps (`db-migrations`, `keycloak-realm`, `seaweed-s3-config`,
`prometheus-config`, `prometheus-rules`, `grafana-datasources`,
`grafana-dashboard-provider`, `grafana-dashboards`, `loki-config`,
`promtail-config`). All are regenerated idempotently by the `config` target.

The target uses **server-side apply**. `kubectl apply` stores a full copy of the
object in the `last-applied-configuration` annotation, which Kubernetes caps at
256 KB — and the dashboard bundle is larger than that. Because make stops at the
first error, the client-side failure silently skipped every configmap after it.

Prometheus re-reads its config only on SIGHUP and Grafana only at startup, so
`config` alone changes nothing for them — that is what `restart-observability`
is for.

### Two ways to deploy: raw manifests vs the Helm chart

The `k8s/` manifests + `Makefile.k8s` are the **lab's** working deployment and
stay authoritative for it. `chart/` is a hand-authored Helm chart (portable
defaults in `values.yaml`, the exact lab config in `values-lab.yaml`) for
deploying the stack anywhere:

```bash
helm upgrade --install chat ./chart -n chat-gsi --create-namespace \
  -f chart/values-lab.yaml -f my-secrets.yaml     # reproduce the lab
```

It is templatized from the same manifests, so the two must not drift: a change
to a workload in `k8s/` should be mirrored in `chart/templates/`, and a change to
a config file under `deploy/` (or `db/migrations/`) must be copied into
`chart/files/` — the chart ships its own copy because `.Files` cannot read
outside the chart dir. Service names are kept **bare** (not release-prefixed) so
the shipped Prometheus/Grafana/Promtail configs work unchanged; one install per
namespace. See `chart/README.md`.

### Faster inner loop

`make -f k8s/Makefile.k8s dev-forward` port-forwards `db:5432`, `valkey:6379` and
`seaweed-s3:8333` to localhost, so `npm run dev` in `frontend/` runs natively
against cluster state. Keycloak needs no forward — `keycloak.lab` already
resolves from the Fedora box.

## 5. Hostnames — the part most likely to be broken by accident

Seven names in `/etc/hosts` on the Fedora box, all pointing at the node, all
served by Traefik ingress:

| Name | Serves |
|---|---|
| `chat.lab` | frontend |
| `keycloak.lab` | Keycloak |
| `s3.lab` | SeaweedFS S3 gateway |
| `grafana.lab` | Grafana (llmbot-admin only, §7) |
| `prometheus.lab` | Prometheus, for ad-hoc PromQL |
| `uptime.lab` | Uptime Kuma (§7a) |
| `status.lab` | the public status page (§7a) |

Grafana's pod carries the same `hostAliases` block as the frontend, for the same
reason: its OAuth redirect goes through the browser to `keycloak.lab` and the
token exchange that follows goes from the pod to that identical name.

**The invariant:** OIDC requires that the browser and the frontend pod resolve
the issuer to the *identical URL string*. The browser gets there via
`/etc/hosts`; the pod gets there via a `hostAliases` block in
`k8s/40-frontend.yaml` mapping the same names to `192.168.50.119`. That
routes pod → node IP → Traefik → Keycloak (a hairpin, which does work here).

Consequences:

- Do **not** change `OIDC_ISSUER` to an in-cluster name like
  `http://keycloak/realms/gsi`. It resolves, and it breaks login, because the
  discovery document still advertises `keycloak.lab`.
- Do **not** add ports to these URLs. Services map 80 → the container port, so
  the compose-era `:8081` and `:3000` are gone.
- `deploy/keycloak/realm-gsi.json` must keep `http://chat.lab/auth/callback` in
  `redirectUris` and `http://chat.lab` in `webOrigins`. Removing them produces
  `invalid_redirect_uri` at login and nothing else.
- Values in `.env` for `OIDC_ISSUER`, `OIDC_REDIRECT_URI`, `APP_ORIGIN`,
  `S3_PUBLIC_ENDPOINT`, `KEYCLOAK_BASE_URL` are **overridden** by explicit `env:`
  entries in the Deployment. Editing `.env` for these has no effect — edit
  `k8s/40-frontend.yaml`.

Verify the invariant after any change to this area:

```bash
curl -s http://keycloak.lab/realms/gsi/.well-known/openid-configuration | head -c 120
kubectl -n chat-gsi exec deployment/frontend -- \
  node -e "fetch('http://keycloak.lab/realms/gsi/.well-known/openid-configuration').then(r=>r.json()).then(j=>console.log(j.issuer))"
```

Both must print `http://keycloak.lab/realms/gsi`.

## 6. State — read before debugging data problems

**Postgres migrations run once.** `db/migrations/` is mounted at
`/docker-entrypoint-initdb.d`, which Postgres only executes against an *empty*
data directory. Adding a migration file and re-running `config` does nothing to
an existing database. Either apply it by hand:

```bash
kubectl -n chat-gsi exec -i deployment/db -- psql -U llmbot -d llmbot < db/migrations/00X_foo.sql
```

or wipe and re-init (destroys all data):

```bash
kubectl -n chat-gsi scale deployment/db --replicas=0
kubectl -n chat-gsi delete pvc db-data
kubectl -n chat-gsi scale deployment/db --replicas=1
```

**Keycloak is ephemeral.** It runs `start-dev` with no PVC, so its H2 database
dies with the pod and `realm-gsi.json` re-imports on every restart. Users created
through the admin console do not survive. This is intentional while the realm
file is being edited; add a PVC if that changes.

**Client secrets are hardcoded in the realm file** (`dev-client-secret-change-me`,
`dev-admin-client-secret-change-me`) and must match `OIDC_CLIENT_SECRET` and
`KEYCLOAK_ADMIN_CLIENT_SECRET` in `.env`. A mismatch fails only at token
exchange, well after login appears to start working.

**Storage.** Everything uses the `local-path` StorageClass — data sits in
`/var/lib/rancher/k3s/storage/` on the node. PVCs are `ReadWriteOnce`, which is
why the stateful Deployments use `strategy: Recreate`; switching them to
`RollingUpdate` deadlocks.

**`seaweed-volume` is a StatefulSet, not a Deployment,** so each replica keeps a
stable DNS name to register with the master. Scale with:

```bash
kubectl -n chat-gsi scale statefulset/seaweed-volume --replicas=3
```

**`.env` parsing.** The Secret is built with `--from-env-file`, which does not
strip quotes. `KEY="value"` puts the quote characters into the secret.

## 7. Observability — one metrics server, one endpoint

**There is exactly one scrape target: `frontend:3000/metrics`.** Nothing else in
the stack exports Prometheus metrics, and nothing else should be made to.

The frontend owns a single registry (`frontend/src/lib/server/metrics/`). Its own
counters — HTTP, auth, LLM, embeddings, retrieval, orchestrator, S3, uploads,
Postgres timings — are incremented as it runs. Everything *outside* the process
is a **collector**: at scrape time the frontend queries Postgres, the SeaweedFS
master and its volume servers, Valkey and Keycloak, and renders their answers
into the same exposition. So there are no exporter sidecars, no second ingress,
and nothing to reconfigure when a backend moves.

The cost of that design, and the thing to remember when reading a dashboard: a
frontend outage takes the *whole* exposition with it. `up{job="chat-gsi"}` and
`chatgsi_collector_up{collector=...}` are both on the overview dashboard because
"the app is down" and "one backend is down" must never look alike.

Adding a metric:

- Declare it in `metrics/metrics.ts`, never inline at a call site. That file is
  the cardinality budget — if a label is added, that is where it is justified.
- Label values are truncated and sanitised by the registry, and a metric is
  capped at 2000 series. Route labels use the SvelteKit **route id**
  (`/api/conversations/[id]`), never the resolved path.
- Anything requiring a query to another service belongs in `metrics/collectors.ts`
  with a timeout, behind the `cached()` helper. Collector answers are reused for
  `METRICS_CACHE_SECONDS` (15s) so an open Grafana tab is not a load generator.

**`db.ts` wraps queries in a timing proxy that hooks `then` and nothing else.**
This is deliberate and fragile-looking: `sql\`...\`` also builds *fragments*
(`retrieval.ts` interpolates one for the knowledge-base filter), and a fragment
must never execute on its own. A Query is a lazy thenable, so awaiting is both
what runs it and the only honest place to start a clock. Do not "simplify" this
into wrapping the returned promise — that would execute every fragment.

### Grafana

Ten provisioned dashboards (262 panels) in the `chat.gsi.de` folder: **Overview**,
**Canvas**, **Storage**, **Files**, **Users & activity**, **LLM & retrieval**,
**Crawler**, **Vector database**, **Caches**, **Logs**. They are files in
`deploy/grafana/dashboards/`,
not objects in Grafana's database, and the UI is read-only (`allowUiUpdates:
false`). To change a panel: "Save As" to experiment, then copy the JSON back into
the repo and re-run `config` + `restart-observability`.

The Storage dashboard is the one worth understanding before an incident:

- `chatgsi_object_storage_capacity_bytes` is **configured** (`S3_CAPACITY_BYTES`,
  25 TiB), not measured. The headline gauge is usage against the *plan*.
- `chatgsi_seaweed_disk_bytes` is the **real** filesystem under the volume
  servers — on k3s that is `/var/lib/rancher/k3s/storage`, shared with every
  other PVC. At 3% of plan the real disk can still be full.
- **"Accounting gap"** subtracts what the database thinks is stored from what
  SeaweedFS actually holds. The difference is orphaned objects. Quota is enforced
  against the database number, so a growing gap means the disk fills faster than
  any user's quota says it can. It is not zero today.

### Access: llmbot-admin only

Grafana login goes through Keycloak (`grafana` client in `realm-gsi.json`) and is
restricted to the **`llmbot-admin`** realm role. Two settings do it, and both are
required:

- `role_attribute_path: contains(roles[*], 'llmbot-admin') && 'Admin'`
- `role_attribute_strict: true` — without this an authenticated non-admin would
  silently receive the default org role and be able to read every dashboard.

`roles` is a flat claim placed into the **ID token and userinfo** by a protocol
mapper on the client; Keycloak's own `realm_access.roles` is access-token only
and awkward to reach from JMESPath. Verified end to end: `testuser` →
Admin, `manager` and `normaluser` → refused.

Grafana's local login form is disabled, so there is no way in that bypasses
Keycloak. **Recovery** if Keycloak is broken: set
`GF_AUTH_DISABLE_LOGIN_FORM=false` and log in as `admin` with
`GRAFANA_ADMIN_PASSWORD`.

`GRAFANA_OIDC_CLIENT_SECRET` must match the `secret` on the `grafana` client in
the realm file, exactly as `OIDC_CLIENT_SECRET` must — the same silent failure
mode described in §6, arriving at token exchange well after login appears to work.

> **Keycloak's `CLIENT.DESCRIPTION` column is `VARCHAR(255)`.** A longer
> `description` on any client in `realm-gsi.json` aborts the entire realm import
> and crash-loops the pod with a `Value too long` H2 error. Already cost one
> debugging round; keep client descriptions short.

### Logs (Loki)

Promtail runs as a DaemonSet, tails `/var/log/pods`, and pushes to Loki; Grafana
queries it as the `loki` datasource. Retention is 31 days and the compactor
enforces it — without `retention_enabled` in `deploy/loki/loki.yaml` the
retention setting is decoration and the PVC grows forever.

Both the frontend (`$lib/server/log.ts`) and the crawler (`crawler/app/log.py`)
emit **one JSON object per line**, so a single `| json` query spans two
languages. Fields are stable because dashboards depend on them; `level` and
`kind` are promoted to Loki labels, everything else stays in the unindexed body.

Two things that will bite:

- **`| json` on a mixed namespace aborts the whole query.** Postgres, SeaweedFS
  and Keycloak do not emit JSON, and one unparseable line fails a metric query
  outright rather than being skipped. Always write `| json | __error__="" | …`.
- **`/metrics` and `/health` are excluded from the access log at the source.**
  Two probes would otherwise be ~20k lines a day of "a robot checked and all was
  well". Their failure is already visible as the scrape target going down.

### Crawler control (db/migrations/018, 019)

`/admin` → Quellen can start, pause, stop and schedule crawls. The frontend still
cannot start a process; it writes intent to `crawl_control` / `crawl_requests`
and the **`crawler-tick` CronJob** (every 5 minutes) acts on it. That is also
what makes the interval an admin setting rather than a systemd unit — `tick`
asks the database what is due.

- **Pause and Stop take effect at a page boundary**, because that is the only
  place where no request is in flight and no document is half-written.
- **A stopped run never runs the delete sweep.** It saw only the pages
  discovered before the button was pressed, so everything after that point would
  look deleted. Verified: stopping a wiki crawl at 202 of ~460 pages deleted
  nothing. This is the same hazard as the empty-discovery guard in §6, wearing a
  different hat.
- A stop is a **timestamp**, and the crawler ignores any stop older than its own
  start — otherwise a stop pressed against nothing running would lie in wait and
  kill an unrelated run an hour later. It is cleared by the crawler, never by the
  UI.
- A run left `running` by a killed pod blocks every future scheduled crawl of
  that source, so `tick` reaps runs whose heartbeat has gone stale before doing
  anything else.

### Crawl modes, and why changed-only was worth the trouble

| Mode | Behaviour |
|---|---|
| `incremental` | fetch everything, compare content hashes (the old default) |
| `changed-only` | skip the fetch, or the processing, when the source says nothing changed |
| `full` | re-embed everything regardless |
| `skip-existing` | never revisit a known page; fast, but blind to edits |

`changed-only` works in two steps: a sitemap `<lastmod>` that matches lets it
skip the request entirely, and otherwise it issues a conditional GET and treats a
304 as unchanged. A 304 still pays the crawl delay but skips LLM extraction,
chunking and embedding — roughly 27 of the 28 seconds a page actually costs.

**Absence of a validator always means "fetch it", never "assume unchanged."**
Getting that backwards would silently freeze the corpus with no error anywhere.

Three separate bugs made this do nothing at all, all of them silent, and all
worth knowing about before touching this code again:

1. **`touch()` did not record the validator.** A page that never changes is
   never upserted, so the pages changed-only exists to skip were exactly the
   pages that never got a validator. It now refreshes them on touch as well.
2. **Apache's `mod_deflate` appends `-gzip` to the ETag *after* evaluating
   `If-None-Match`.** A client that faithfully echoes the ETag it was given never
   matches, and the server answers 200 forever. `If-None-Match` takes a list, so
   we send both the stored and the suffix-stripped form.
3. **Discovery URLs and stored URLs differ across a redirect.** virgo-docs is
   listed under `hpc.gsi.de/virgo/…` and stored under `virgo-docs.hpc.gsi.de/…`.
   The content-hash check never noticed because it runs after the fetch; the
   revision check runs before it and missed every time. Hence
   `documents.discovered_url` (019).

Measured on virgo-docs after all three: **41 pages, 40 skipped without a fetch,
205 s → 5 s.** Note the payoff needs one full run first to populate validators —
the admin UI shows "N mit Revision" so that warm-up is visible rather than
mysterious.

Per source, whether it pays off at all depends on the server:

| Source | Validators | Effect |
|---|---|---|
| `virgo-docs` | ETag + Last-Modified | full benefit, verified |
| `www` | sitemap `<lastmod>` | request skipped when lastmod matches |
| `wiki` | **none** — no ETag, no Last-Modified | falls back to a normal incremental crawl |

`wiki.gsi.de` sends neither validator, so changed-only is safely a no-op there.
That is the correct fallback, not a bug — but do not expect the mode to speed up
the wiki crawl.

## 7a. Status page — deliberately not part of the stack

`uptime.lab` runs Uptime Kuma; `status.lab` is a small AI agent that turns its
data into a status page with incident history, modelled on githubstatus.com.

**Everything about this is built to survive the stack failing**, because the one
moment anybody opens a status page is the moment something is broken:

- no `depends_on`, no init container, no Service of the monitored stack in any
  readiness path, and no connection to the application's Postgres — incidents
  live in the agent's own SQLite;
- under compose it sits on its own `status` network, so its checks reach the app
  the way a user does rather than through a private network where a check can
  pass while every real request gets a 502 from Traefik;
- `/healthz` answers "is the status page alive", never "is the stack healthy" —
  otherwise Kubernetes would restart it during exactly the outage it exists to
  report.

The one link is a **read-only** mount of Kuma's SQLite database, opened with
`mode=ro` so the agent physically cannot write it. `statuspage/app/kuma.py`
explains why the database and not an API: every API route needs manual setup
first (a session, an API key, or a published status page), which defeats an agent
that is supposed to just run.

On k3s both containers share one pod. That is the exception to one-process-per-
container, and it buys something concrete: `local-path` is ReadWriteOnce, so a
separate Deployment could not mount Kuma's volume without pinning both to the
same node anyway.

### What the AI actually does

**The model writes prose. It never produces facts.** Which component, when it
started, how long it lasted, what the check reported, the severity — all computed
in code and either injected as a FACTS block or rendered outside the model's text
entirely. The model's job is to turn `keycloak: connect ECONNREFUSED` into
"signing in is unavailable".

That line is the whole design. A status page exists to be believed during an
incident, and one invented duration or fabricated root cause ends that
permanently. So every call has a deterministic fallback, and the page labels
which one a reader is looking at with an `AI` badge.

Decisions are code, not prompts: an incident opens after `OPEN_AFTER` failing
checks and resolves after `RESOLVE_AFTER` healthy ones (resolve is stricter —
declaring victory early and re-opening reads far worse than resolving late).
Correlated failures fold into **one** incident: when Postgres goes down the
frontend check fails moments later, and that is one event to a reader, not two.

Verified end to end: healthy → frontend down → Keycloak folded in and severity
escalated to critical → both recovered → resolved plus an "All systems
operational" note, with the AI writing all four updates.

### Setting it up

Uptime Kuma's admin account has to be created once by hand at
`http://uptime.lab` — that is the only manual step. After that, set
`KUMA_ADMIN_USER` / `KUMA_ADMIN_PASSWORD` in `.env` and the agent creates the
default checks itself on startup (`statuspage/app/provision.py`):

| Monitor | URL |
|---|---|
| Chat interface | `http://chat.lab/health` |
| Sign-in (Keycloak) | `http://keycloak.lab/realms/gsi/.well-known/openid-configuration` |
| File storage | `http://s3.lab/healthz` |
| Dashboards (Grafana) | `http://grafana.lab/api/health` |
| Monitoring (Prometheus) | `http://prometheus.lab/-/healthy` |

Provisioning is the ONE thing that writes to Kuma, and it goes through the real
socket.io API rather than the database — writing another process's SQLite behind
its back is how you corrupt it. It is idempotent (matches on name), only ever
adds, and never resurrects a monitor somebody deleted or paused on purpose. It
retries on a background thread because Kuma needs about a minute after a cold
start before its socket accepts a login.

The checks target the **`.lab` hostnames**, never in-cluster Service names: a
check against `http://frontend:3000` would pass while every real user got a 502
from Traefik. That is the outage nobody would notice.

The monitor NAME is what appears on the status page and in incident text, so name
them for readers, not for infrastructure. `statuspage/app/writer.py` maps common
names to user-facing impact; anything unrecognised is passed through as-is.

### Degraded, outage, maintenance

Three kinds of event, thresholds in `statuspage/app/classify.py`:

| Condition | After | Result |
|---|---|---|
| slow but answering | 2 min sustained | `degraded` |
| not answering | 3 min | `outage` |
| not answering **and** Kubernetes reports a rollout | 3 min | `maintenance` |

"Slow" is **relative and floored**: 3× the component's own 6-hour median AND at
least 250 ms. These checks answer in ~13 ms, so a pure multiple would fire on
13 ms → 40 ms and a pure absolute would never fire at all.

`kube.py` reads the Kubernetes API (read-only, one namespace, `k8s/80-status.yaml`
holds the Role) purely to tell a deploy apart from a fault. Two things that were
wrong first time and are easy to get wrong again:

- **`readyReplicas < spec.replicas` never fires during a RollingUpdate** —
  `maxSurge` means ready and updated already equal the wanted count while the
  rollout runs. Measured: `spec.replicas=1 replicas=2 ready=1 updated=1
  unavailable=1`. Watch the **surge** and `unavailableReplicas` instead.
- **Monitor names and workload names share no words.** "Chat interface" is the
  monitor, `frontend` is the Deployment. `kube.WORKLOAD` maps them and needs an
  entry per monitor, exactly like `writer.IMPACT`.

Kubernetes unreachable ⇒ no maintenance classification, and the event stays an
outage. That is the honest answer, and it keeps §7a's independence rule intact:
the API server is not part of the stack being reported on.

The **thresholds** are code; the **classification and wording** are the model's.

**Drill it with real signal, not fake heartbeats.** `make -f k8s/Makefile.k8s
status-drill` (`deploy/status-drill.py` + `statuspage/app/drilltools.py` +
`k8s/90-status-drill.yaml`) stands up a throwaway target, points a test monitor at
it, and drives real degraded → outage → maintenance, asserting the right incident
opens each time. The target has independent `/` (monitored) and `/ready`
(readiness) paths — that separation is what lets one target produce an outage
(pod Ready, app failing → no rollout) and a maintenance (never-Ready rollout)
without one masquerading as the other. Runs ~12–18 min because the thresholds are
real. It already found and fixed one bug: `degraded` used to flap, because a slow
monitor is still `status = up` and `_handle_recovery` resolved it a poll after
`_handle_slow` opened it. `Agent._still_slow` now holds a degradation open until
the slowness actually clears (classify no longer returns `degraded`).

### "Operational" must mean "we checked"

A monitor that exists but has never produced a heartbeat has `status = None`.
Counting that as healthy would put a green banner up during the window when
nothing has been verified at all — the single worst thing a status page can do.
So the overall state is derived only from monitors that have actually reported:
none reporting is `Status Unknown`, some reporting and some never run is
`Mostly Operational`, and the banner text says which checks it is still waiting
for. Only a fully-reported, fully-healthy set gets `All Systems Operational`.

## 7b. The documents agent — the only outbound reach in a turn

Every chat turn also searches **indico.gsi.de**, **repository.gsi.de** and the
PDFs that crawled pages link to (`frontend/src/lib/server/orchestrator/docsagent.ts`,
`.../sources/`). Full notes in `docs/developer/documents-agent.md`; the parts
that will bite are here.

**It runs on every turn, in both modes,** and is not gated on a planner — a
planner deciding "does this need Indico?" would have to know what is in Indico.
It is affordable because it is off the critical path (started before retrieval,
awaited just before the answer) and can never fail a turn. `DOCS_AGENT_ENABLED=false`
turns it off without a redeploy.

**Passing the question straight to these searches finds nothing.** Indico and
Invenio are AND-based keyword indexes; measured against indico.gsi.de:
`Was macht das CBM Experiment?` → 0 attachments, `CBM Experiment` → 3, `CBM` →
10. Hence `searchTerms()`. This is the same trap the image agent's `image_query`
rule documents for media.gsi.de, and it fails **silently** both times — the
search succeeds and returns an empty list.

**repository.gsi.de blocks robots on purpose.** `/search`, `/record/<id>` and
every `/record/<id>/files/*.pdf` return a 248-byte JS bot challenge that
penalises `navigator.webdriver`. Verified across retries, User-Agents and
cookies. **Do not try to defeat it.** The two interfaces left open are the ones
meant for machines — `/rss?p=<query>` and `/oai2d` — and those are what the code
uses. Consequence: repository results are bibliographic pointers with **no full
text and no abstract** (no `dc:description` on any record sampled, no MARC 520),
so they are marked `read: false` everywhere and the prompt forbids claiming
anything about their contents.

**Indico's search API needs `type`,** or it answers 422 with an HTML body — a
JSON parse failure with no clue why. `contribution` and `subcontribution` are
accepted but return nothing on this instance; `total: -1` means "not counted",
not zero; `pagenav.next` is an opaque cursor, not a page number.

Fetching reuses `pdfscope` + `fetchdoc` + `externalcache`, so the agent is not a
second, weaker egress path. `fetchdoc.ts` was **extracted** from `/api/pdf`
rather than copied — that redirect-checking is the egress boundary and two copies
would drift.

External citations continue the corpus numbering but cannot live in the
`citations` table (`chunk_id` is a foreign key into `chunks`). They round-trip in
the message trace, with the marker carried per source rather than recomputed.

## 8. Do not do these without being asked

- `sudo /usr/local/bin/k3s-uninstall.sh` — destroys the cluster and all data.
- `make -f k8s/Makefile.k8s nuke` / `kubectl delete namespace chat-gsi` — same
  for the app.
- Change the node's IP, hostname, or `--node-ip`. The hostname is baked into the
  node object and the IP into `--tls-san` on the API server certificate;
  changing either means reinstalling k3s.
- Re-enable swap, or unmask the sleep targets. Both are off deliberately —
  a suspended node takes the whole cluster down, and it is a laptop.
- Enable ufw. It is inactive; enabling it without
  `sudo ufw allow from 192.168.50.0/24` cuts off the API server, NodePorts and
  the registry pull path at once.

## 9. Triage order

```bash
kubectl -n chat-gsi get pods                       # what is not Ready
kubectl -n chat-gsi describe pod <name>            # Events section, read bottom-up
kubectl -n chat-gsi logs <name> --previous         # if it is restarting
kubectl -n chat-gsi logs <name> -c wait-for-deps   # frontend stuck in Init
```

| Symptom | Cause |
|---|---|
| `ImagePullBackOff` on a `192.168.50.112:5000/...` image | registry container stopped on Fedora, or the image was never pushed |
| Frontend stuck `Init:0/1` | a backing service is not Ready; the init container names which one in its logs |
| `Pending` PVC | node disk full, or a `ReadWriteOnce` PVC still bound to a terminating pod |
| Login redirect loop or `invalid_redirect_uri` | §5 |
| Token exchange fails after login page works | secret mismatch, §6 |
| Node `NotReady`, everything unreachable | laptop suspended or lid closed; §8 |
| Pods cannot reach the LLM proxy | check `192.168.50.1:8080/api/v1` from the node itself first |
| Every Grafana panel empty at once | the frontend is down — it is the only scrape target, §7 |
| One dashboard section empty, rest fine | that collector cannot reach its backend; check `chatgsi_collector_up` |
| Grafana says "user does not have a role" | the account lacks `llmbot-admin`; that is the gate working, §7 |
| Keycloak `CrashLoopBackOff` after a realm edit | a client `description` over 255 chars, §7 |
| Panel shows "No data" where 0 is expected | a PromQL vector-match failure — the two sides carry different labels |
| Loki panel errors with `JSONParserErr` | a `| json` without `| __error__=""`, §7 |
| changed-only skips nothing | validators not populated yet (needs one full run), or the source sends none — §7 |
| Crawl stuck `running` forever | the pod died; the next `tick` reaps it after 15 min |
| Queued crawl never starts | the `crawler-tick` CronJob is not running |
| Status page says "Status Unknown" | no monitors created in Uptime Kuma yet, §7a |
| Answers never cite Indico or the repository | keyword extraction produced nothing, or the sources are unreachable from the pod — check `chatgsi_document_agent_runs_total`, §7b |
| `chatgsi_external_searches_total{outcome="challenged"}` climbing | repository.gsi.de now challenges the RSS interface too; it looks exactly like "no results", §7b |
| Incidents read like templates | the LLM proxy is unreachable; the `AI` badge is absent, §7a |
| A deploy shows as an outage, not maintenance | `kube.WORKLOAD` has no entry for that monitor, or the Role was never applied — check the agent log for `kubernetes read failed`, §7a |
| Nothing is ever reported `degraded` | the component is fast enough that 3× its median is still under the 250 ms floor, §7a |

## 10. Human documentation

`docs/` holds the written documentation, split by reader: `docs/user/` (using and
administering it), `docs/developer/` (setup, architecture, testing, runbook), and
`docs/executive/` (status, risk, production readiness).

This file stays the operating manual for working *on* the cluster and is the more
current source for operational detail. When a change makes something in `docs/`
wrong, fix it there — in particular `docs/developer/testing.md`, which stands in
for the test suite this repo does not have.

## 11. Reporting back

State what was actually verified versus what was assumed. If a change touches
§5 or §6, run the verification commands given there and quote the output rather
than asserting it worked — both failure modes are silent until a user tries to
log in.

A change to §7 is verified by *querying*, not by looking at the pod:
`make -f k8s/Makefile.k8s metrics` for the exposition, and every dashboard
expression run through `/api/v1/query` — a panel whose PromQL cannot match
returns an empty result, which renders as "No data" and is indistinguishable
from a metric nobody has exercised yet.
