# Observability

## The rule

**There is exactly one scrape target: `frontend:3000/metrics`.** Nothing else in
the stack exports Prometheus metrics, and nothing else should be made to.

```
frontend/src/lib/server/metrics/
  registry.ts     hand-written registry: sanitising, series caps, render()
  metrics.ts      every metric declared in one place — the cardinality budget
  collectors.ts   scrape-time queries into Postgres, SeaweedFS, Valkey, Keycloak
  index.ts        the public surface
frontend/src/routes/metrics/+server.ts   the endpoint
```

The frontend's own counters are incremented as it runs. Everything *outside* the
process is a **collector**: at scrape time the frontend queries the backends and
renders their answers into the same exposition. No exporter sidecars, no second
ingress, nothing to reconfigure when a backend moves.

### The cost of that design

A frontend outage takes the **whole** exposition with it. `up{job="chat-gsi"}` and
`chatgsi_collector_up{collector=…}` are both on the Overview dashboard because
"the app is down" and "one backend is down" must never look alike.

A failing collector emits `chatgsi_collector_up{collector=…} 0` rather than
dropping its metrics — a missing series and a zero series are different facts, and
`rate()` treats a gap very differently from a zero.

## Adding a metric

1. **Declare it in `metrics.ts`.** Never inline at a call site. That file is the
   cardinality budget; if a label is added, that is where it is justified.
2. **Route labels use the SvelteKit route id** (`/api/conversations/[id]`), never
   the resolved path. The resolved path is unbounded cardinality.
3. **Anything needing another service goes in `collectors.ts`**, with a timeout,
   behind `cached()`.

The registry defends itself: label values are truncated to 120 characters and
stripped of `\`, `"` and newlines, and each metric is capped at 2000 series.

`DEFAULT_BUCKETS` extends to 300 s because a `gsi-deep` turn is budgeted 180 s. A
histogram whose top bucket is below the real p99 tells you nothing at the moment
you need it.

### Collectors

```ts
cached(ttlMs, fn)   // failures are NOT cached; in-flight calls are shared
withTimeout(ms, p)  // must stay under prometheus.yml's scrape_timeout (10s)
```

`METRICS_CACHE_SECONDS` (15 s) matches the scrape interval. Without it, a Grafana
panel on auto-refresh re-runs the storage aggregation on every browser tick — an
open dashboard becomes a load generator.

Nine collectors: `runtime`, `postgres`, `crawler`, `vectors`, `activity`,
`externalCache`, `seaweed`, `valkey`, `keycloak`. The Seaweed one discovers volume
servers from the master's topology, so scaling the StatefulSet needs no config
change.

## The database timing proxy

`db.ts` wraps queries in a Proxy that hooks **`then` and nothing else**:

```ts
function timed<T extends object>(query: T): T {
  return new Proxy(query, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'then' || typeof value !== 'function') return value;
      return (onFulfilled?: unknown, onRejected?: unknown) => { /* time + count */ };
    }
  });
}
```

This is deliberate and fragile-looking. ``sql`…` `` also builds **fragments** —
`retrieval.ts` interpolates one for the knowledge-base filter — and a fragment
must never execute on its own. A Query is a lazy thenable, so awaiting is both
what runs it and the only honest place to start a clock.

**Do not "simplify" this into wrapping the returned promise.** That would execute
every fragment.

## Metric families

| Prefix | From |
|---|---|
| `chatgsi_http_*` | the `handle` hook, wrapping `auth` so gate rejections still count |
| `chatgsi_auth_*`, `chatgsi_active_sessions` | session lifecycle |
| `chatgsi_llm_*` | including `time_to_first_token`, the number users feel |
| `chatgsi_embedding_*`, `chatgsi_retrieval_*` | the RAG path |
| `chatgsi_orchestrator_*` | rounds, sub-agents, budget exhaustion |
| `chatgsi_db_*` | the timing proxy above |
| `chatgsi_s3_*`, `chatgsi_upload_*`, `chatgsi_file_*` | storage |
| `chatgsi_crawl_*` | collector over `crawl_runs` / `crawl_control` |
| `chatgsi_vector_*`, `chatgsi_corpus_*` | pgvector state |
| `chatgsi_seaweed_*`, `chatgsi_object_storage_*` | object storage |
| `chatgsi_valkey_*`, `chatgsi_cache_*` | caches |
| `chatgsi_users`, `chatgsi_active_users`, `chatgsi_conversations*` | activity |
| `chatgsi_collector_up`, `chatgsi_build_info` | meta |

`make metrics` prints the whole thing.

> `chatgsi_user_stored_bytes` **names users**. `METRICS_TOKEN` is deliberately
> unset on the isolated lab subnet; it must be set before this ever gets an
> internet-facing ingress.

## Dashboards

Ten, provisioned from `deploy/grafana/dashboards/` into the `chat.gsi.de` folder.
262 panels.

"Panels" is the total; "on open" is what you actually see before expanding a
row, which is the number that decides whether a dashboard is usable.

| File | Dashboard | Panels | On open |
|---|---|---|---|
| `overview.json` | Overview (weathermap + saturation) | 40 | 10 |
| `storage.json` | Storage | 36 | 10 |
| `files.json` | Files | 30 | 12 |
| `users.json` | Users & activity | 29 | 9 |
| `llm.json` | LLM & retrieval | 28 | 11 |
| `crawler.json` | Crawler | 26 | 9 |
| `vectors.json` | Vector database | 24 | 11 |
| `cache.json` | Caches | 23 | 12 |
| `logs.json` | Logs | 19 | 8 |
| `canvas.json` | Canvas — full topology | 5 | 4 |

### Rows are collapsed on purpose

Every dashboard opens with its **first row expanded and the rest folded**
(`deploy/grafana/collapse.py`). Before that, all rows were expanded and Overview
alone was 86 grid units of continuous scroll — 39 panels with no landmarks, which
is the same as none.

If you edit a dashboard by hand, re-run the script. And note the part that is
easy to get wrong: **a collapsed row owns its children.** They move into
`row["panels"]` and out of the top-level list. Setting `collapsed: true` without
moving them yields closed rows whose panels are all still visible underneath,
which reads as a rendering bug.

### The node graph is a weathermap

`deploy/grafana/nodegraph.py` generates it; edit the tables there and re-run
rather than editing the JSON.

**Edges carry throughput, nodes carry health.** A node's number is its p95
latency as a *percentage of a budget for that hop*, which is what makes Postgres
(100 ms budget) and the LLM proxy (30 s) comparable on one screen. The bottleneck
is simply the highest number, and the same figures are ranked on the "Where the
time goes" bars beside it.

The budgets are opinions and are listed in that file so they can be argued with.

Two PromQL details that are load-bearing:

- **`histogram_quantile` returns NaN, not absence, for a histogram with no recent
  observations.** `or vector(0)` therefore never fires, and every idle component
  renders as a blank bar. The `>= 0` in `saturation()` drops the NaN so the
  fallback can work — NaN fails every comparison.
- The old version showed a rate per node in its own unit (req/s beside auth/min
  beside "pages this run"). Nothing was comparable, so it proved traffic existed
  and never said where it was struggling.

**They are files, not objects in Grafana's database**, and the UI is read-only
(`allowUiUpdates: false`). To change a panel: "Save As" to experiment, copy the
JSON back into the repo, then `config` + `restart-observability`.

### Storage, before you need it in an incident

- `chatgsi_object_storage_capacity_bytes` is **configured** (`S3_CAPACITY_BYTES`,
  25 TiB), not measured. The headline gauge is usage against the *plan*.
- `chatgsi_seaweed_disk_bytes` is the **real** filesystem under the volume
  servers — on k3s that is `/var/lib/rancher/k3s/storage`, shared with every other
  PVC. **At 3% of plan the real disk can still be full.**
- **"Accounting gap"** subtracts what the database thinks is stored from what
  SeaweedFS actually holds. The difference is orphaned objects. Quota is enforced
  against the database number, so a growing gap means the disk fills faster than
  any user's quota says it can. It is not zero today.

### PromQL traps found here

**Vector matching.** `chatgsi_seaweed_disk_bytes{state="used"} /
chatgsi_seaweed_disk_bytes{state="all"}` can never match — the label sets differ.
Wrap both sides in `sum()`. Five dashboard expressions and **two alert rules that
could never have fired** had this.

**Node-graph duplicates.** `or` deduplicates only *identical* label sets.
`rate()` and bare selectors carry `instance`/`job`; `vector(0)` does not. `sum()`
both.

A panel whose PromQL cannot match returns an empty result, which renders as "No
data" and is **indistinguishable from a metric nobody has exercised**. That is why
dashboard changes are verified by querying — see
[Testing](testing.md#observability).

## Logs (Loki)

Promtail runs as a DaemonSet, tails `/var/log/pods`, pushes to Loki; Grafana
queries it as the `loki` datasource.

Both the frontend (`$lib/server/log.ts`) and the crawler (`crawler/app/log.py`)
emit **one JSON object per line**, so a single `| json` query spans two languages.
`level` and `kind` are promoted to Loki labels; everything else stays in the
unindexed body. Field names are stable because dashboards depend on them.

Two things that will bite:

- **Two spellings of one level.** Python's logger says `WARNING`, the frontend
  says `warn`, and `level` is promoted to a Loki *label* — so `level = "warn"`
  (matchers are fully anchored) silently missed every crawler warning, and
  `sum by (level)` split the graph into two half-height series. Normalised at the
  source in `crawler/app/log.py`; dashboard queries also fold `warning` into
  `warn` with `label_replace`, because logs already in Loki keep the old spelling
  for their retention window.
- **`| json` on a mixed namespace aborts the whole query.** Postgres, SeaweedFS
  and Keycloak do not emit JSON, and one unparseable line fails a metric query
  *outright* rather than being skipped. Always write `| json | __error__="" | …`.
- **`/metrics` and `/health` are excluded from the access log at the source.** Two
  probes would otherwise be ~20k lines a day of "a robot checked and all was
  well". Their failure is already visible as the scrape target going down.

Retention is 31 days and the compactor enforces it. **Without `retention_enabled`
in `deploy/loki/loki.yaml` the retention setting is decoration** and the PVC grows
forever.

## Grafana access: llmbot-admin only

Login goes through Keycloak (`grafana` client in `realm-gsi.json`). Two settings,
both required:

- `role_attribute_path: contains(roles[*], 'llmbot-admin') && 'Admin'`
- `role_attribute_strict: true` — **without this an authenticated non-admin
  silently receives the default org role** and can read every dashboard.

`roles` is a flat claim placed into the ID token and userinfo by a protocol mapper
on the client. Keycloak's own `realm_access.roles` is access-token only and awkward
to reach from JMESPath.

Verified end to end: `testuser` → Admin; `manager` and `normaluser` → refused.

The local login form is disabled, so there is no way in that bypasses Keycloak.
**Recovery** if Keycloak is broken: `GF_AUTH_DISABLE_LOGIN_FORM=false` and log in
as `admin` with `GRAFANA_ADMIN_PASSWORD`.

`GRAFANA_OIDC_CLIENT_SECRET` must match the realm file, with the same silent
failure mode as every other client secret: it fails at token exchange, well after
login appears to work.

Grafana's pod carries the same `hostAliases` block as the frontend and for the
same reason — the OAuth redirect goes through the browser to `keycloak.lab` and
the token exchange that follows goes from the pod to that identical name.

## Alerts

Seven rules in `deploy/prometheus/rules/chat-gsi.yml`. After editing:

```bash
make -f k8s/Makefile.k8s config
make -f k8s/Makefile.k8s restart-observability
```

Then **run each rule's expression through `/api/v1/query`**. Two of the original
seven contained vector-match failures and could never have fired; nothing about a
loaded rule tells you it is capable of matching.
