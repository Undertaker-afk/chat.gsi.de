# Database

Postgres 16 + pgvector. `db/migrations/`, numbered, applied in order.

## The thing that catches everyone

**Migrations run exactly once, against an empty data directory.**

`db/migrations/` is mounted at `/docker-entrypoint-initdb.d`, which Postgres only
executes when it initialises a fresh cluster. Adding a migration file and re-running
`config` does **nothing** to an existing database.

Apply it by hand:

```bash
make -f k8s/Makefile.k8s migrate FILE=db/migrations/020_thing.sql
# or, on compose:
make migrate FILE=db/migrations/020_thing.sql
```

Or wipe and re-init — **destroys all data**:

```bash
kubectl -n chat-gsi scale deployment/db --replicas=0
kubectl -n chat-gsi delete pvc db-data
kubectl -n chat-gsi scale deployment/db --replicas=1
```

Write migrations so hand-application is safe: `IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`, idempotent `INSERT … ON CONFLICT DO NOTHING`. Assume every migration will
be run against a database that may already have part of it.

## The migrations

| # | What |
|---|---|
| 001 | extensions (`vector`, `pg_trgm`, …) |
| 002 | core schema — sources, documents, chunks, conversations, messages |
| 003 | retrieval indexes: GIN on `tsv`, and the vector index |
| 004 | seed source rows |
| 005 | message branching (edit a question → a new branch) |
| 006 | attachments, bytes in Postgres |
| 007 | **attachment bytes move out** to SeaweedFS |
| 008 | knowledge bases and delegated access control |
| 009 | backfill `kb_id` for the existing wiki corpus from the URL |
| 010 | record how a crawl run was invoked |
| 011 | crawl requests from the admin UI |
| 012 | generated files |
| 013 | generated files cascade-delete with the conversation |
| 014 | cache of external documents (the PDF proxy) |
| 015 | every URL the corpus links to — the allowlist for the PDF proxy |
| 016 | **generated files outlive their conversation** (reverts 013) |
| 017 | which generated files a user attached to a question |
| 018 | crawl control, scheduling, run telemetry |
| 019 | `documents.discovered_url` |

013 → 016 is worth reading as a pair. Cascading generated files away with the
conversation was defensible and wrong in practice: the script was usually the
thing the user wanted and the conversation was just how they got it.

## Key tables

### Corpus

```
sources         slug, base_url, connector, enabled
documents       url, discovered_url, title, kb_id, content_hash,
                revision, last_modified, last_seen_run, deleted_at
chunks          document_id, heading_path, text, embedding vector, tsv
knowledge_bases label, source_slug, is_default
```

`discovered_url` (019) exists because discovery and storage URLs differ across
redirects: virgo-docs is *listed* under `hpc.gsi.de/virgo/…` and *stored* under
`virgo-docs.hpc.gsi.de/…`. Revision lookups key on
`coalesce(discovered_url, url)`.

Deletion is soft (`deleted_at`), so a bad sweep is recoverable with
`crawler reindex --undelete`.

### Access control

```
groups          name, description
group_members   group_id, user_sub, is_manager, restricted
group_grants    group_id, kb_id      -- the CEILING, set by an admin
member_grants   group_id, user_sub, kb_id   -- the SUBSET, set by a manager
```

`restricted` is an explicit flag so **"not customised" is distinguishable from
"customised to nothing"** — otherwise revoking a manager's last tick would silently
restore full access.

The ceiling is enforced server-side on every write, not merely hidden in the UI.

### Crawl control (018)

```
crawl_control   source_id, desired_state, stop_requested_at,
                interval_minutes, mode, next_run_at
crawl_requests  one pending per source
crawl_runs      status, mode, pages_seen/changed/skipped/restricted/failed/
                unfetched, chunks_written, bytes_fetched, deleted,
                heartbeat_at, requested_by
```

`crawl_runs.status` accepts `stopped` as of 018. `heartbeat_at` is what lets the
UI distinguish a paused crawl from a dead one, and what lets `tick` reap runs left
`running` by a killed pod.

### Conversations

```
conversations   title, mode, user_sub
messages        parent_id (branching), role, content, images, agent_trace
attachments     message_id ON DELETE CASCADE, s3_key, bytes, mime
generated_files survive their conversation (016)
feedback        thumbs up/down per message
hidden_conversations   revocation grace period
audit_log       actor, action, target, detail jsonb
```

## Retrieval indexes

Dense and lexical run in parallel and are fused with RRF.

The vector index is an **exact scan by default**. An HNSW index exists as an opt-in
because at this corpus size exact search is fast and exact:

```bash
make ann-index    # builds a halfvec(2048) HNSW index
```

`retrieval.ts` must be switched to a two-stage query before that index is actually
used. Building it alone changes nothing — read `003_indexes.sql` before running it.

## Quota accounting

`octet_length`, not `pg_column_size`. The number shown to a user should be what
they wrote, so it stays stable when Postgres changes its mind about TOAST
compression.

Uploads (`sum(attachments.bytes)`) and chats (message content, agent traces,
titles) share one `UPLOAD_QUOTA_BYTES`.

## Backups

```bash
make backup      # pg_dump | gzip → data/backups/
```

This covers the database only. Object storage is **not** included — attachments
and generated files live in SeaweedFS. A restore from `make backup` alone gives
you rows pointing at objects that no longer exist.

## Direct access

```bash
make psql                                            # compose
kubectl -n chat-gsi exec -it deployment/db -- psql -U llmbot -d llmbot   # k3s
```
