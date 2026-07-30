# Architecture

## The shape of it

```
                          ┌──────────────┐
   browser ─────────────▶│  SvelteKit   │◀──── Keycloak (OIDC, PKCE, server-side)
                          │   frontend   │
                          │              │──┬─▶ Postgres + pgvector   (corpus, chats, ACL)
                          │  /metrics ───┼──┼─▶ Valkey                (sessions, cache)
                          └──────────────┘  ├─▶ SeaweedFS S3          (uploads, generated)
                                 ▲          └─▶ LLM proxy 192.168.50.1:8080/api/v1
                                 │
                          Prometheus ──▶ Grafana ◀── Loki ◀── Promtail
                                 
   wiki.gsi.de ─┐
   virgo-docs   ├──▶ crawler (CronJob every 5 min: "what is due?") ──▶ Postgres
   www.gsi.de  ─┘

   ─────────── deliberately disconnected from all of the above ───────────
   Uptime Kuma (uptime.lab) ──ro SQLite──▶ AI status agent (status.lab)
```

## Components

| Component | Stack | Job |
|---|---|---|
| frontend | SvelteKit 2, Svelte 5, adapter-node | UI, API, orchestration, auth, **and the only metrics endpoint** |
| crawler | Python 3.12, httpx, selectolax, psycopg | fetch → extract → chunk → embed |
| Postgres | 16 + pgvector | corpus, chunks, conversations, groups, grants, audit |
| Valkey | 8 | sessions, external-fetch cache |
| SeaweedFS | master / volume / filer / s3 | object storage; the volume tier is the shardable one |
| Keycloak | `start-dev` | identity only — read-only to us |
| Prometheus / Grafana / Loki / Promtail | | metrics, dashboards, logs |
| Uptime Kuma + status agent | | independent availability reporting |

## The request path

```
POST /api/chat
  → hooks.server.ts     resolve session from Valkey, refresh if <60s left
  → permissions         compute the caller's knowledge-base ids
  → orchestrator        gsi-fast or gsi-deep
      → embeddings      embed the query WITH the instruct prefix
      → retrieval       hybrid: dense (pgvector) + lexical (tsquery), fused by RRF
                        filtered by kb_id IN (...) inside the SQL, not after
      → LLM             answer with citations
  → SSE                 status / agent / token / citation / title / done
```

## Decisions worth knowing

### Retrieval is hybrid, not pure vector

Dense retrieval alone loses on exact tokens — `sbatch`, `/lustre/rz`, an error
string — which is a large share of real GSI questions. Lexical search and vector
search run separately and are fused with Reciprocal Rank Fusion. It is the
cheapest fix and needs no extra model.

**Qwen3-Embedding-8B is asymmetric**: queries take an instruct prefix, documents do
not. Getting that wrong silently degrades recall with no error anywhere, so it
lives in exactly one place — `embedQuery` / `embedDocuments` in
`lib/server/embeddings.ts` — and nowhere else.

Retrieve top 40 → RRF → 8 chunks for fast, 12 for deep.

### Access control is a SQL filter, not a post-filter

`retrieve()` applies `d.kb_id = ANY($ids)` to **both** arms. A chunk the caller may
not see never enters the ranking, so it cannot influence the answer or leak
through a citation. Deep mode inherits it: sub-agents are handed the same list as
the lead. With no grants the function short-circuits to empty and the orchestrator
says so.

### Deep mode's limits are code, not prompts

3 rounds, 4 sub-agents per round (12 calls worst case), 180-second wall clock. On
timeout it answers from what it has and marks the answer partial. Sub-agents
cannot spawn sub-agents — one level, no recursion. The lead only ever sees
sub-agent *findings*, never their raw chunks; without that, round 2 of a
4-sub-agent fan-out overflows the 200k context window.

### Tokens never reach the browser

Authorization Code + PKCE, entirely server-side. The browser holds an opaque
session ID in an httpOnly SameSite=Lax cookie; tokens live in Valkey. The GSI
proxy API key never leaves the server.

### Object storage, not `bytea`

Migration 006 kept attachments in Postgres; 007 moved them out. A per-user
gigabyte quota does not belong in `pg_dump`, every read copied the whole image
through Node, and one Postgres instance is not something you can spread over more
machines.

The S3 client is a hand-written SigV4 signer, not `@aws-sdk/client-s3` — five
operations against one endpoint do not justify ~15 MB of dependencies in the
image. Talking S3 keeps the door open to MinIO, Ceph RGW or AWS as an endpoint
change.

Download links are presigned per request and expire in 300 seconds. Messages
persist the stable `/api/uploads/<id>` path, never the signed URL, so nothing on
record can expire.

Write ordering is chosen so failures degrade harmlessly: **on write the object
goes first** (a stray object is invisible garbage; a row without an object is a
broken image), **on delete the row goes first** (an orphan object beats a row the
user cannot get rid of).

### One metrics endpoint

The frontend owns a single registry. Its own counters are incremented as it runs;
everything outside the process is a **collector** that queries Postgres, SeaweedFS,
Valkey and Keycloak *at scrape time*. No exporter sidecars, no second ingress,
nothing to reconfigure when a backend moves.

The cost: a frontend outage takes the whole exposition with it. That is why `up`
and `chatgsi_collector_up` are adjacent on the Overview dashboard — "the app is
down" and "one backend is down" must never look alike. See
[Observability](observability.md).

### The documents agent runs on every turn

It searches indico.gsi.de, repository.gsi.de and PDFs linked from crawled pages,
and it is not gated on a planner — a planner deciding "does this need Indico?"
would have to know what is in Indico. It is affordable because it is off the
critical path and can never fail a turn.

Two things it taught, both silent failures: **these are AND-based keyword
indexes**, so passing the question through unchanged finds nothing at all
(`Was macht das CBM Experiment?` → 0 hits, `CBM` → 10); and
**repository.gsi.de deliberately blocks robots** on `/search` and file downloads
while leaving RSS and OAI-PMH open, so its results are bibliographic pointers
with no full text and no abstract. Those are marked `read: false` end to end.
See [Documents agent](documents-agent.md).

### The crawler cannot be started by the frontend

The frontend writes *intent* to `crawl_control` / `crawl_requests`; a CronJob
running every five minutes asks the database what is due and acts. That is what
makes the crawl interval an admin dropdown rather than a systemd unit, and it
means the web tier never spawns a process. See [Crawler](crawler.md).

### The status page shares nothing

No `depends_on`, no init container, no service of the monitored stack in any
readiness path, and its own SQLite for incidents. `/healthz` answers "is the
status page alive", never "is the stack healthy" — otherwise Kubernetes would
restart it during exactly the outage it exists to report. See
[Status page](status-page.md).

## Data model

Rough map; `db/migrations/` is authoritative.

```
sources ──▶ documents ──▶ chunks (embedding vector, tsvector)
                │
                └── kb_id ──▶ knowledge_bases
                                  ▲            ▲
                        group_grants      member_grants
                          (ceiling)          (subset)
                              ▲                 ▲
                           groups ──── group_members
                              
conversations ──▶ messages ──▶ attachments ──▶ (S3 object)
                       │  └──▶ generated_files
                       └──▶ feedback

crawl_runs, crawl_requests, crawl_control     the crawler's control plane
audit_log                                     who changed what
external_cache                                fetched non-corpus URLs
hidden_conversations                          revocation grace period
```

See [Database](database.md).
