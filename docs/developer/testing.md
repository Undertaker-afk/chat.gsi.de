# Testing

There is no automated test suite. That is a real gap — see
[Delivery status](../executive/delivery-status.md#known-gaps) — and this document
is what stands in for it.

**The governing principle here: almost every failure mode in this system is
silent.** A broken access filter returns results. A broken PromQL query renders
"No data", which looks the same as a metric nobody has exercised. A crawler mode
that skips nothing still finishes successfully. None of these throw. So testing
means *querying for the expected value*, not checking that something did not
crash.

---

## The smoke test

Run this after any deploy. Five minutes.

```bash
# 1. everything is up
kubectl -n chat-gsi get pods                 # all Running, none restarting
curl -s http://chat.lab/health               # {"status":"ok"}

# 2. the LLM proxy, embedding dims and database agree
podman compose run --rm crawler check        # or the k8s equivalent

# 3. the exposition renders and collectors succeeded
make -f k8s/Makefile.k8s metrics | grep chatgsi_collector_up
#    every collector must be 1

# 4. Prometheus is scraping
curl -s 'http://prometheus.lab/api/v1/query?query=up{job="chat-gsi"}' | jq '.data.result[0].value[1]'
#    "1"

# 5. the status page agrees
curl -s http://status.lab/api/status.json | jq '.overall, .sources'
```

Then sign in and ask one question that you know has an answer. Confirm citations
appear and one of them opens the right page.

---

## Auth and access control

**Test as all three dev users.** Most access-control bugs are invisible as an
admin.

| User | Password | Expect |
|---|---|---|
| `testuser` | `testuser` | Einstellungen + Administration; Grafana works |
| `manager` | `manager` | Einstellungen + Verwaltung; Grafana **refused** |
| `normaluser` | `normaluser` | Einstellungen only; Grafana **refused** |

### The knowledge-base filter

This is the highest-consequence thing in the system. Test it by *value*, not by
looking at the UI:

1. As an admin, note a knowledge base `normaluser` does **not** have.
2. As `normaluser`, ask a question whose answer only exists in that base.
3. The answer must not contain the content **and must not cite it**. A citation
   list is the leak path that survives a good-looking answer.

Then check the composer footer names exactly the bases you expect.

### The ceiling is enforced server-side

The manager UI only shows knowledge bases inside the group's ceiling. That is the
UI being helpful, not the boundary. Verify the boundary directly:

```bash
curl -X POST http://chat.lab/api/management/groups/1/members \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"user_sub":"…","kb_ids":[999]}'      # a kb outside the ceiling
# must be rejected
```

### Revocation

Revoke a knowledge base from a user who has conversations citing it. Expect: those
conversations vanish from their sidebar, their URLs 404, and the rows land in
`hidden_conversations` — hidden, not deleted, for `REVOCATION_GRACE_DAYS`.

### OIDC

After any change touching hostnames or the realm file, run the two commands in
[Setup](setup.md#hostnames). Both must print `http://keycloak.lab/realms/gsi`.
A mismatch breaks login and nothing else reports it.

---

## Observability

A dashboard change is verified by **querying**, never by looking at the pod.

```bash
# every panel expression, through the API
curl -s --get 'http://prometheus.lab/api/v1/query' --data-urlencode 'query=<expr>' | jq .status
# "success" with an empty result is NOT a pass
```

**Sweep all of them, not a sample.** Walk every panel in every dashboard,
substitute the dashboard variables the way Grafana would (`$__rate_interval`,
`$__auto`, `$__range`, and each template variable), and send each expression to
**the datasource its own panel names** — a Loki query sent to Prometheus proves
nothing. `prometheus.lab` does not resolve from every shell; run it from inside
the cluster:

```bash
kubectl -n chat-gsi exec deployment/frontend -- node -e "…"   # see git history
# current state: total=320  returning data=301  empty=19  INVALID=0
```

Three outcomes, and they are not interchangeable: **INVALID** is a broken query,
**empty** is a metric nobody has exercised yet, and **data** is working. The
first two both render as "No data" on screen, which is exactly why this is run
against the API instead of read off a dashboard.

The 318 dashboard expressions were verified this way: 299 returning data, 0
invalid. The 19 with no data are metrics nobody has exercised yet, which is
different from a broken query — and telling those apart is the entire point of
checking.

Four failure classes found this way, all of which render as "No data":

**Vector-match failures.** `chatgsi_seaweed_disk_bytes{state="used"} /
chatgsi_seaweed_disk_bytes{state="all"}` can never match — the two sides carry
different label sets. Wrap both in `sum()`. Two *alert rules* had this and could
never have fired.

**`| json` without `| __error__=""`.** Postgres, SeaweedFS and Keycloak do not emit
JSON, and **one unparseable line fails the whole LogQL metric query** rather than
being skipped. Always write `| json | __error__="" | …`.

**Wrong datasource.** Six stat panels pointed at Prometheus with LogQL. Four
failed loudly; two parsed as valid PromQL — `{app=~"..."}` is a legal selector —
and would have shown empty forever.

**`$__rate_interval` in a Loki query.** Grafana does not interpolate it for Loki,
so LogQL gets it literally: `not a valid duration string: "$__rate_interval"`.
Use `$__auto`. This one shipped because an earlier sweep only ran the Prometheus
expressions — the lesson being that "I verified the queries" has to mean *all* of
them, against *the datasource each panel actually names*.

**Node-graph duplicates.** `or` deduplicates only *identical* label sets.
`rate()` and bare selectors carry `instance`/`job`; `vector(0)` does not. Wrap in
`sum()`.

### Checking a log query

```bash
curl -s --get 'http://loki:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={app="frontend"} | json | __error__="" | level="error"' \
  --data-urlencode "start=$(date -d '1 hour ago' +%s)000000000" | jq '.data.result | length'
```

---

## The crawler

### Verify a mode does what it claims

Finishing successfully proves nothing — `changed-only` skipping zero pages is a
successful run.

```bash
podman compose run --rm crawler crawl --source virgo-docs --mode changed-only
podman compose run --rm crawler status
```

Compare `pages_seen` against `pages_unfetched`. On virgo-docs after a warm-up run
the expected shape is **41 pages, 40 unfetched, ~5 s**. If it is 41 seen and 0
unfetched taking 205 s, the mode is doing nothing, and there are three known
reasons — see [Crawler](crawler.md#why-changed-only-silently-did-nothing).

`changed-only` needs one full run first to populate validators. The admin UI shows
"N mit Revision" precisely so that warm-up is visible rather than mysterious.

### Pause and stop

Verified behaviour to reproduce:

- **Pause** — the page counter stalls (193 → 194 then holds), *and the heartbeat
  stays fresh*. A stalled counter with a stale heartbeat is a crash, not a pause.
  The two must be checked together.
- **Stop** — the run ends with status `stopped` and **deletes zero documents**,
  even though it saw only a fraction of the source. Verified: stopping at 202 of
  ~460 pages prevented ~258 deletions. If a stopped run ever reports deletions,
  the sweep guard is broken and the corpus is being damaged.

### The delete sweep

The most dangerous code path in the crawler. Two guards:

1. A run that saw **zero** pages never sweeps (a failed discovery would otherwise
   delete the entire corpus).
2. A **stopped** run never sweeps.

After any change to `pipeline.py`, re-verify both. The failure is silent and
destroys data.

---

## The documents agent

It runs on **every** turn, so a bug here affects every answer, and its failure
mode is the quietest in the system: the searches succeed and return nothing.

```bash
# 1. Can the POD reach the sources? Different question from the dev box.
kubectl -n chat-gsi exec deployment/frontend -- node -e "
  fetch('https://indico.gsi.de/search/api/search?q=CBM&type=attachment')
    .then(r => r.json()).then(j => console.log(j.results.length))"

# 2. The funnel. Each stage dropping to zero is a different problem.
make -f k8s/Makefile.k8s metrics | grep -E 'external_searches|external_hits|document_agent_runs|document_reads'
```

Then ask a question containing an obvious acronym (`Was macht das CBM
Experiment?`) and read the `documents` SSE event.

**`state: "none"` with `searched: 0` means keyword extraction is broken.** That
is the bug that shipped in the first version: the raw question was passed to
AND-based keyword indexes, which match nothing. It looks identical to "Indico
genuinely has nothing about this", and nothing throws.

| Query | Indico attachments |
|---|---|
| `Was macht das CBM Experiment?` | **0** |
| `CBM Experiment` | 3 |
| `CBM` | 10 |

Other checks worth doing deliberately:

- **A repository citation must render "nur Metadaten".** Those records have no
  full text *and no abstract*, so the answer must not claim anything about their
  contents — only that the publication exists.
- **A picked candidate that could not be read must still appear as a source.**
  The second bug here dropped them: an Indico `.pptx` deck was picked, could not
  be text-extracted, and then vanished entirely rather than becoming a pointer.
  Watch for `outcome="nothing_readable"` with a non-zero `picked` in the log.
- **A question with no proper noun** should produce `outcome="no_query"` and no
  searches at all.
- **`DOCS_AGENT_ENABLED=false`** must leave answers otherwise unchanged.
- **`outcome="challenged"`** on repository searches means the bot challenge has
  spread to the RSS interface. It is indistinguishable from "no results" without
  that label.

## The status page

### The drill (automated, real signal)

```bash
make -f k8s/Makefile.k8s status-drill                    # all phases, ~12-18 min
make -f k8s/Makefile.k8s status-drill ARGS="--phase maintenance --keep"
```

`deploy/status-drill.py` stands up a throwaway target (`k8s/90-status-drill.yaml`),
points a **test** Kuma monitor at it, and drives it through each event, asserting
the right kind of incident opens:

| Phase | What the drill does to the target | Expected verdict |
|---|---|---|
| baseline | healthy for ~80 s | establishes a response-time baseline |
| degraded | answers `700 ms` slow for > 2 min | `degraded` |
| outage | returns 503, **pod stays Ready** (no rollout) | `outage` |
| maintenance | `set env` → real Recreate rollout that never becomes Ready | `maintenance` |

It never fakes a heartbeat. Kuma genuinely observes the target, the running agent
genuinely classifies it, and the writer genuinely narrates it — so a pass means
the whole loop works, not just `classify()`. The `await` output prints each
incident's title, body and **AI/template** tag, so you can read the prose the model
produced. Everything (target, monitor, incidents) is cleaned up at the end; after a
Ctrl-C or `--keep`, run `make -f k8s/Makefile.k8s status-drill-clean`.

**Why the two independent paths.** The target has a monitored path (`/`) and a
readiness path (`/ready`) that switch separately. That is the only way one target
tells outage from maintenance: outage is `/` failing while the pod stays Ready
(kube.py sees no rollout); maintenance is a genuine rollout whose new pod is
deliberately never-Ready (kube.py reports it, so `down` becomes `maintenance`).

The thresholds are real (2 min, 3 min), so the run is slow by construction —
that is the point of testing with real signal rather than injected beats.

> **A bug this drill found and fixed.** The `degraded` incident used to flap: a
> slow monitor still reports `status = up`, so `_handle_recovery` resolved the
> degradation the poll after `_handle_slow` opened it, and it re-opened every
> poll. Fixed by `Agent._still_slow` — a degradation only resolves once the
> slowness has actually cleared (classify no longer returns `degraded`), not
> merely because the monitor is up. The drill still scans recent incidents rather
> than only open ones, so it stays robust regardless.

### Manually, if you want to watch it live

1. In Uptime Kuma, add an HTTP check against something guaranteed dead
   (`http://192.168.50.119:9`).
2. Expect within ~2 minutes: banner → **Partial System Outage**, then an incident
   published after two consecutive failures, citing the **real** error string.
3. Point it at something working.
4. Expect: resolved after three healthy checks, plus an "all clear" note.
5. **Delete the test monitor and its incident** — otherwise it sits in the public
   history.

Check the **AI** badge. Present means the model wrote the prose. Absent means the
LLM proxy was unreachable and you are reading the deterministic fallback — the
page keeps reporting either way, which is the design.

Then verify the model invented nothing: the duration in the text must match the
real outage window, because durations are computed in code and injected, never
generated.

### The "operational must mean we checked" case

Create a monitor and read `/api/status.json` before its first check completes.
Expect **`partial_unknown`** ("Mostly Operational"), never `operational`. A
monitor with `status = None` counting as healthy is the single worst bug this page
can have.

---

## The database timing proxy

`frontend/src/lib/server/db.ts` wraps queries in a Proxy that hooks **`then` and
nothing else**. It looks like it wants simplifying. It does not.

`sql\`…\`` builds both queries *and fragments* — `retrieval.ts` interpolates one
for the knowledge-base filter — and **a fragment must never execute on its own**.
A Query is a lazy thenable, so awaiting it is both what runs it and the only
honest place to start a clock. Wrapping the returned promise instead would execute
every fragment.

If you touch it, verify against a live database that an interpolated fragment
still executes as part of its parent statement and is never counted separately:

```bash
make -f k8s/Makefile.k8s metrics | grep chatgsi_db_queries_total
# then run one search, and check the counter moved by the number of real
# statements, not by the number of sql`` template literals
```

---

## Storage and quota

- Upload past `UPLOAD_MAX_FILE_BYTES` → **413** with the real figures, not a
  generic error.
- Fill the quota, then `POST /api/chat` → also **413**. Both paths enforce it.
- Attach an image and never send it → it still counts. (Otherwise an abandoned
  upload hides storage.)
- Delete a conversation → its attachments go too.
- Tamper with a presigned URL's signature → **403** from the gateway.
- Let a link age past `S3_LINK_TTL_SECONDS` → it stops working, and the message
  still resolves because it stores the stable path.

---

## Manual regression checklist

Before calling a change done:

- [ ] Sign in as all three dev users; account menus differ correctly
- [ ] One Fast question, with citations that open
- [ ] One Deep question; agent trace populates and collapses
- [ ] Edit a message → branches, `< 2 / 2 >` pager, old branch intact
- [ ] Attach an image; re-attach one from Verlauf
- [ ] A generated file appears on **Dateien** and survives deleting its conversation
- [ ] `make metrics` — all collectors 1
- [ ] Grafana loads for `testuser`, refuses `normaluser`
- [ ] Overview and Canvas render without "No data" in panels that should have data
- [ ] `status.lab` green, `/api/status.json` sources all `true`
- [ ] A crawl starts from the admin UI and its progress bar moves

---

## Reporting results

State what was **verified** versus what was **assumed**. For anything touching
hostnames, secrets or metrics, quote the command output rather than asserting it
worked — those failure modes stay silent until a user tries to log in or an
incident starts and the dashboard is empty.
