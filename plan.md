# chat.gsi.de — GSI RAG Assistant

**Status:** full stack running under Podman; shadcn-svelte UI with dark mode, chat history, AI-named conversations and branching message edits
**Last updated:** 2026-07-28

A retrieval-augmented chat assistant over GSI documentation, with Keycloak SSO.
The LLM service (`llmbot.gsi.de`) already exists and is **not ours to run** — during the
praktikum it is reached through a local OpenAI-compatible proxy. We build and host the
retrieval layer, the frontend, and auth.

---

## 1. What we host vs. what already exists

| | Component | Who runs it |
|---|---|---|
| ✅ ours | **pgvector** (Postgres 17) — corpus, embeddings, conversations | us |
| ✅ ours | **frontend** `chat.gsi.de` — SvelteKit, incl. server-side orchestrator | us |
| ✅ ours | **Keycloak** — OIDC provider | us |
| ✅ ours | **crawler** — weekly batch job, not a long-lived service | us |
| ❌ external | **llmbot** — chat + embedding models | GSI (via proxy in dev) |

The orchestrator lives **inside the SvelteKit server**, not as a separate service. That
keeps the hosted surface to what you asked for. The trade-off is honest: retrieval SQL
and agent logic end up in TypeScript rather than Python. If deep mode grows heavy it
splits out into its own container later without touching the frontend — it's already
behind an internal module boundary (`lib/server/orchestrator/`).

---

## 2. Verified LLM endpoint facts

Probed 2026-07-27 against `http://192.168.50.1:8080`. **`info.md` has one error:**
it documents `/api/chat/completions`, which returns **403**. The working paths are:

| Purpose | Path | Verified |
|---|---|---|
| List models | `GET /api/v1/models` | 200 |
| Chat | `POST /api/v1/chat/completions` | 200 |
| Embeddings | `POST /api/v1/embeddings` | 200 |

Everything hangs off base URL `http://192.168.50.1:8080/api/v1` with
`Authorization: Bearer pk-praktikum2026`. Backend is **vLLM behind Open WebUI**
(`system_fingerprint: vllm-0.26.0`). `/v1/*` without the `/api` prefix → 405.

### Model assignment

| Model | Role | Vision | Notes |
|---|---|---|---|
| `llmbot.mistral-small-4-119b` | **chat** — lead agent + subagents | ✅ | User-facing answers, user image uploads |
| `llmbot.qwen3.6-27b` | **crawl** — HTML→Markdown, figure captioning | ✅ | Cheaper, vision needed for diagrams |
| `Qwen/Qwen3-Embedding-8B` | **embeddings** | — | 4096 dims, `max_model_len` 40960. Hidden in the model list but fully accessible |
| `llmbot.gpt-oss-120b` | fallback / cheap classification | ❌ | Query rewriting, routing |

Measured: batch of 32 inputs → 4096-dim vectors in **0.6 s**. Batching works, so
ingestion throughput is not a constraint. Context window is **200000** for the chat
models — this is the real budget limit and the orchestrator is built around it.

---

## 3. Architecture

```
                    ┌──────────────────┐
                    │  wiki.gsi.de     │  (Foswiki — confirmed)
                    └────────┬─────────┘
                             │ orange: weekly crawl
                             ▼
                    ┌──────────────────────────────┐        ┌────────────────────────┐
                    │  crawler (batch container)   │───────►│  GSI LLM proxy         │
                    │  fetch → qwen3.6-27b →       │◄───────│  /api/v1               │
                    │  Markdown → chunk → embed    │  blue  │                        │
                    └────────┬─────────────────────┘        │  mistral-small-4-119b  │
                             │ red: new embeddings          │  qwen3.6-27b           │
                             ▼                              │  Qwen3-Embedding-8B    │
                    ┌──────────────────┐                    └───────────┬────────────┘
                    │    pgvector      │                                │
                    │   (postgres)     │                          blue: │ prompts/answers
                    └────────▲─────────┘                                │
                             │ blue: retrieved chunks out               │
                    ┌────────┴──────────────────────────────────────────┴──┐
                    │            chat.gsi.de  (SvelteKit)                  │
                    │  ┌────────────────────────────────────────────────┐  │
                    │  │ server-side orchestrator                       │  │
                    │  │   gsi-fast : 1 agent,  1 round                 │  │
                    │  │   gsi-deep : ≤3 rounds × ≤4 subagents          │  │
                    │  └────────────────────────────────────────────────┘  │
                    │  red: user input ──►      ◄── blue: streamed answer  │
                    └──────────────────────┬───────────────────────────────┘
                                           │ OIDC
                                           ▼
                                    ┌─────────────┐
                                    │  Keycloak   │
                                    └─────────────┘
```

Colour convention from the whiteboard, held throughout: **red = input** (user input into
chat, new embeddings into the vector DB); **blue = output** (chunks out of pgvector,
prompts out of chat to the LLM, answers back); **orange = source content and the
citation links back to it**.

### Services

| Service | Image / stack | Port | Notes |
|---|---|---|---|
| `frontend` | SvelteKit 2 / Svelte 5, `adapter-node`, Node 22 | 3000 | SSR + orchestrator + OIDC session |
| `db` | `pgvector/pgvector:pg17` | 5432 | internal only |
| `keycloak` | `quay.io/keycloak/keycloak:26` | 8081 | dev mode locally, `start` in prod |
| `valkey` | `valkey/valkey:8-alpine` | 6379 | sessions, crawl lock, rate limit |
| `crawler` | Python 3.12 | — | `podman compose run` + weekly systemd timer |
| `proxy` | `caddy:2-alpine` | 8443 | TLS, prod only |

**Port note:** the Znuny test instance in `info.md` occupies host `8080`, so nothing here
binds 8080. Keycloak takes 8081.

**Dev-box reality check:** this machine has 8 cores / 7 GB RAM with ~2 GB free. Keycloak
(~700 MB) + Postgres + Node is tight but fits if Znuny isn't running at the same time.
`compose.dev.yaml` sets `JAVA_OPTS_KC_HEAP=-Xms256m -Xmx512m` on Keycloak for that
reason. If it thrashes, run `make dev-noauth` — a stub session provider that skips
Keycloak entirely and injects a fixed dev user. That stub is **hard-disabled unless
`NODE_ENV=development`**, so it cannot ship.

---

## 4. Data model

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE sources (
    id            bigserial PRIMARY KEY,
    slug          text UNIQUE NOT NULL,          -- 'wiki'
    base_url      text NOT NULL,
    connector     text NOT NULL,                 -- 'foswiki' | 'html'
    config        jsonb NOT NULL DEFAULT '{}',   -- api path, include/exclude globs
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crawl_runs (
    id            bigserial PRIMARY KEY,
    source_id     bigint NOT NULL REFERENCES sources(id),
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running',  -- running|ok|failed|partial
    pages_seen    int NOT NULL DEFAULT 0,
    pages_changed int NOT NULL DEFAULT 0,
    pages_deleted int NOT NULL DEFAULT 0,
    error         text
);

CREATE TABLE documents (
    id            bigserial PRIMARY KEY,
    source_id     bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url           text NOT NULL,
    title         text NOT NULL,
    content_hash  text NOT NULL,                 -- sha256 of normalised markdown
    markdown      text NOT NULL,
    frontmatter   jsonb NOT NULL DEFAULT '{}',
    lang          text,
    last_seen_run bigint REFERENCES crawl_runs(id),
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,
    UNIQUE (source_id, url)
);

CREATE TABLE chunks (
    id            bigserial PRIMARY KEY,
    document_id   bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal       int NOT NULL,
    heading_path  text[] NOT NULL DEFAULT '{}',
    anchor        text,
    text          text NOT NULL,
    token_count   int NOT NULL,
    embedding     vector(4096),                  -- Qwen3-Embedding-8B, confirmed
    tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
    UNIQUE (document_id, ordinal)
);

CREATE INDEX chunks_embedding_hnsw ON chunks
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);

CREATE TABLE conversations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub      text NOT NULL,
    title         text,
    mode          text NOT NULL DEFAULT 'fast',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user ON conversations (user_sub, updated_at DESC);

CREATE TABLE messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            text NOT NULL,
    content         text NOT NULL,
    images          jsonb,                       -- user uploads (vision models)
    trace           jsonb,                       -- rounds, subagents, timings
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE citations (
    message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chunk_id      bigint NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    marker        int NOT NULL,
    score         real,
    PRIMARY KEY (message_id, marker)
);

CREATE TABLE feedback (
    message_id    uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    user_sub      text NOT NULL,
    rating        smallint NOT NULL,             -- -1 | +1
    comment       text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
```

**HNSW build note:** 4096-dim vectors are large (~16 KB each). Build the HNSW index
**after** the initial bulk ingest, not before — index-then-insert is many times slower.
Migration `003` creates it; the bootstrap script runs it last.

---

## 5. Crawler

### Output format — Markdown

Replaces the flat `.txt` export. One file per page in
`data/corpus/<source>/<url-slug>.md`, with YAML frontmatter:

```markdown
---
url: https://wiki.gsi.de/foo/bar
title: Key Authentication
source: wiki
crawled_at: 2026-07-27T12:00:00Z
content_hash: sha256:1a2b3c…
lang: en
headings: ["Access", "Key Authentication"]
---

# Key Authentication

Password based authentication to the compute cluster is not supported…

## Authorized Keys

| Files | Description |
| --- | --- |
| `~/.ssh/id_ed25519` | Private key protected with passphrase. |

```bash
ssh-keygen -q -t ed25519 -f ~/.ssh/id_ed25519
```

![Cooling tower outside the Green Cube](figures/green-cube-tower.png)
<!-- vision: Outdoor evaporative cooling towers connected to the Green Cube by
     large insulated pipes; a water purification container sits front-left. -->
```

Plus `data/corpus/<source>/manifest.json` — every page's url, title, hash, path,
timestamp. That's what makes incremental diffing cheap and the corpus inspectable in a
plain editor or `git diff`.

Why Markdown over the flat export: the old format glued headings onto the following
paragraph (`ConstructionThe Green Cube was…`) and collapsed tables to
`VAE'25Debian 122027`. `heading_path` is one of the strongest retrieval signals we have,
and table structure is exactly what people ask about. Markdown preserves both, chunks
cleanly on `#` boundaries, and stays human-readable.

### Vision-assisted extraction

`llmbot.qwen3.6-27b` is used at crawl time for three things HTML parsing does badly:

1. **Layout-heavy pages** — where readability heuristics produce mush, send the rendered
   HTML for clean Markdown conversion.
2. **Figures** — the wiki has diagrams and photos carrying real information (the
   virgo-docs cooling-tower figures are a good example). The model writes a description
   into an HTML comment beside the image. It gets **embedded with the chunk**, so
   "what does the cooling infrastructure look like" can retrieve a figure.
3. **Screenshot-only tables** — tables that exist as images become real Markdown tables.

This is opt-in per page, not blanket: deterministic extraction runs first, and the model
is invoked only when the extractor's confidence heuristic fails (very low text-to-markup
ratio, or `<img>` with no meaningful `alt`). Keeps a full recrawl from costing thousands
of vision calls.

### Connector interface

```python
class Connector(Protocol):
    def discover(self) -> Iterable[PageRef]: ...
    def fetch(self, ref: PageRef) -> RawPage: ...
    def supports_incremental(self) -> bool: ...
    def changed_since(self, ts: datetime) -> Iterable[PageRef]: ...
```

`HtmlSitemapConnector` (default, works anywhere), `MediaWikiConnector`,
`DokuWikiConnector`, `BookStackConnector`. Chosen per source via `sources.connector`.

### Weekly rescan

`Sunday 03:00 Europe/Berlin`, via a **systemd timer** running
`podman compose run --rm crawler` — not a long-lived scheduler container. A batch job
should be a batch job; systemd already does retries, logging and boot ordering. A Valkey
lock prevents a manual run from overlapping the timer.

Per page:

1. Ask the connector for pages changed since the last successful run, if it can.
2. Fetch → extract → normalise → `sha256`. Hash unchanged → bump `last_seen_run`,
   **skip re-embedding entirely.** This is where nearly all the cost is saved.
3. Changed → re-chunk, re-embed, replace chunks in one transaction.
4. End of run: documents with a stale `last_seen_run` get `deleted_at` set and their
   chunks dropped, so deleted wiki pages stop being cited.

Politeness: 1 rps, `robots.txt` honoured, `If-Modified-Since`,
`User-Agent: gsi-llmbot-crawler/1.0 (+https://chat.gsi.de)`.

### Chunking

- Split on heading boundaries; sections under ~1200 tokens stay whole.
- Oversized sections split on paragraph boundaries with ~15% overlap.
- Code blocks and tables are **never** split mid-block.
- At embed time each chunk is prefixed with its heading path
  (`Access › Key Authentication`) so the vector carries context; stripped before the
  LLM sees it.
- Target 512 tokens, hard ceiling 1024.

---

## 6. Retrieval

Dense (HNSW cosine) and lexical (`tsv` GIN) run in parallel, fused with Reciprocal Rank
Fusion (`k=60`). Pure dense retrieval reliably misses exact identifiers — hostnames,
`sbatch` flags, error strings — which is a large share of real GSI questions. RRF is the
cheapest fix and needs no extra model.

Qwen3-Embedding-8B is **asymmetric**: queries take the instruct prefix
(`Instruct: Given a web search query, retrieve relevant passages\nQuery: {q}`),
documents do not. Getting this wrong silently degrades recall, so it lives in exactly one
place — `embedQuery` / `embedDocuments` in `lib/server/embeddings.ts` — and nowhere else.

Retrieve top 40 → RRF → 8 chunks into context for fast, 12 for deep.

---

## 7. Orchestrator

Two modes, exposed as two model IDs in the picker: `gsi-fast`, `gsi-deep`.

### `gsi-fast` — one agent, one round

```
rewrite query → hybrid retrieve → answer with citations
```

Default. Target p50 under 4 s to first token.

### `gsi-deep` — up to 3 rounds, up to 4 subagents per round

```
Lead (mistral-small-4-119b)
  Round 1: decompose → 1–4 subqueries → spawn N subagents in parallel
           each subagent: retrieve → read → {finding, citations, confidence}
  Lead: synthesise. Explicit gaps remain AND rounds < 3? → next round
  Else: final answer from accumulated findings
```

Limits enforced in code, not left to the model's judgement:

- `MAX_ROUNDS=3`, `MAX_SUBAGENTS_PER_ROUND=4` → 12 subagent calls worst case.
- Wall-clock budget 180 s. On timeout, answer from whatever findings exist, mark partial.
- **Context budget: 200000 tokens** (the real vLLM limit). Subagents each get a slice;
  the lead only ever sees subagent *findings*, never their raw chunks. Without that,
  round 2 of a 4-subagent fan-out overflows the window.
- Subagents are retrieval-and-read only. **They cannot spawn subagents** — one level, no
  recursion.
- Shared deduplicated citation pool, so a chunk found by three subagents is `[4]` once.

Round 2+ only fires when the lead emits explicit unanswered gaps. Most deep queries
should settle in one or two rounds; three is a ceiling, not a target.

### Streaming protocol

`POST /api/chat` (SSE), consumed by our own UI:

```
event: status    {"phase":"retrieving","round":1}
event: agent     {"id":"sub-2","query":"…","state":"running"}
event: agent     {"id":"sub-2","state":"done","findings":2}
event: token     {"text":"Slurm "}
event: citation  {"marker":3,"url":"…","title":"…","heading":"Access › Key Auth"}
event: done      {"message_id":"…","usage":{…},"partial":false}
```

Deep mode's value is visible work — watching subagents spawn and report is what makes a
40-second wait feel purposeful rather than broken.

---

## 8. Frontend

SvelteKit 2 + Svelte 5, `adapter-node`, TypeScript, **Tailwind v4 + shadcn-svelte**
(`vega` preset, `zinc` base, Lucide icons, Inter). Components live in
`src/lib/components/ui/` and are added with `npx shadcn-svelte@latest add <name>`.

**Theming** — `mode-watcher` provides light / dark / system with no flash on load
(`<ModeWatcher />` in the root layout applies the stored theme before paint). All colour
comes from semantic tokens (`bg-background`, `text-muted-foreground`, …), so dark mode
needs no per-component `dark:` overrides.

**Markdown rendering** — `src/lib/markdown.ts`. HTML is escaped *before* markdown
parsing, so the only tags in an answer are the ones `marked` emits plus our own citation
anchors. That closes the injection path (answers echo crawled wiki text) without a
sanitiser dependency. `[n]` markers are swapped for inert placeholders before parsing and
replaced with chips afterwards, so a marker inside a code block or link never breaks.

### Auth (Keycloak OIDC)

Authorization Code + PKCE, **server-side**. Tokens never reach the browser.

```
/login          → redirect to Keycloak authorize; PKCE verifier in a signed cookie
/auth/callback  → exchange code; store tokens in a Valkey session
                  keyed by an opaque httpOnly SameSite=Lax cookie
hooks.server.ts → resolve session, refresh when <60 s remain, populate locals.user
/logout         → clear session + Keycloak end_session_endpoint
```

The browser holds only an opaque session ID. The **GSI proxy API key never leaves the
server** — the browser talks only to our SvelteKit routes.

Realm roles: `llmbot-user` (required to chat), `llmbot-privileged` (department manager,
see §8b), `llmbot-admin` (crawl triggers, stats, group ceilings). The two upper roles are
**composite** and include `llmbot-user`, so nobody can hold an administrative role without
being able to use the thing they administer.

### UI

Mirrors the whiteboard: conversation sidebar, message pane, composer with send button,
model picker top-right (`Fast` / `Deep`).

- Streaming Markdown: tables, code blocks, lists, headings — all themed to the tokens.
- Citations as superscript chips; hover shows `title › heading`, click opens the source
  URL + anchor — the orange arrows. A collapsible source list sits under each answer.
- Collapsible **agent trace** in deep mode: rounds, subagent queries, per-agent state.
  Auto-opens while running and collapses when finished.
- **Composer** modelled on Grok's: a single row while the text fits on one line; once it
  wraps, the textarea takes the full width and the controls (attach, mode, send) drop to
  their own row beneath. Done with flex-wrap + `order` rather than swapping markup, so
  the textarea node is never unmounted and the caret survives the transition. The
  one-line threshold is measured from real font metrics, not a guessed pixel value.
- **Mode picker** is a dropdown in the composer (opens upward), each entry showing a
  label, a one-line description and a check on the active one — replacing the header
  toggle group.
- **Image attachments** by pasting a screenshot, or through the `+` button, which opens a
  drop-up with **Hochladen** and a **Verlauf ›** submenu that unfolds to the right with the
  last 10 uploads. Re-attaching from the history costs no storage — the message references
  an id that already exists — and removing it from the composer does not delete it, since
  it may still belong to an older message. Both chat models are vision-capable. Uploads go
  to the server immediately (`POST /api/uploads`) and the message carries only a reference;
  see §8a. Note: the strict grounding prompt made the model refuse to look at attachments
  ("the sources contain no information about images"), so `IMAGE_ADDENDUM` is appended
  **only when an image is present** — grounding stays strict otherwise.
- **Settings dialog** from the account menu: theme (hell / dunkel / system) and storage
  management — a stacked usage bar (orange = uploads, green = chats, grey = free), the
  per-file list with thumbnails, and delete.
- **Sidebar** (`Sidebar.Root collapsible="offcanvas"`) with conversation history grouped
  by recency (Heute / Gestern / Letzte 7 Tage / Älter), inline rename and delete.
- **AI-named conversations.** After the first exchange the utility model proposes a
  ≤6-word title in the question's language, which is saved and streamed to the client as
  a `title` event. Generated *after* the answer, so it never delays time-to-first-token.
- **Editable messages with version history.** Hovering a user message reveals an edit
  button; saving branches the conversation and a `< 2 / 2 >` pager appears to move
  between versions. The old branch and its answer stay intact.
- **Branding** — the supplied `favicon.ico` is the browser-tab icon. Because it is 16×16
  only, the in-app wordmark is an SVG redraw of the same mark (`Logo.svelte`, orange
  `#feaf6b` lifted from the icon, letters in `currentColor` so it inverts in dark mode).
  Swap it for the official vector asset if one exists.
- Image upload (both chat models are vision-capable) → `messages.images`.
- Per-message 👍/👎 → `feedback`. The only honest signal we'll get on retrieval quality,
  so it ships in v1.
- `Enter` send, `Shift+Enter` newline, `Ctrl+K` conversation search.
- German/English UI strings; answers follow the question's language.

---

## 8a. Uploads and storage

Attachments are indexed in an `attachments` table and the bytes live in **object storage**
(SeaweedFS, S3 API). 006 kept them in a `bytea` column; 007 moved them out, because a
per-user gigabyte quota does not belong in `pg_dump`, every read copied the whole image
through Node, and one Postgres instance is not something you can spread over more machines.

### Object storage — SeaweedFS

Four services, one per role (`compose.yaml`):

| Service | Role |
| --- | --- |
| `seaweed-master` | assigns writes, tracks volumes |
| `seaweed-volume` | holds the bytes — **this is the shardable one** |
| `seaweed-filer` | directory tree over the volumes |
| `seaweed-s3` | S3-compatible gateway (the only one the app talks to) |

**Sharding:** `podman compose up -d --scale seaweed-volume=3` adds capacity. Volume servers
deliberately have no fixed `-ip`, so each replica registers under its own container address
and the master spreads new writes across all of them; the application never notices.
Replication (`-replication=001`) is the next step when there is more than one host.

Credentials and the bucket ACL live in `deploy/seaweedfs/s3.json`. The identity is scoped
to the one bucket (`Read/Write/List/Tagging/Admin:gsi-uploads`); `Admin` is needed only so
the app can create its own bucket on first boot (`ensureBucketOnce`). Talking S3 keeps the
door open: swapping in MinIO, Ceph RGW or AWS is an endpoint change, not a rewrite.

The S3 client (`frontend/src/lib/server/s3.ts`) is a hand-written SigV4 signer rather than
`@aws-sdk/client-s3` — five operations against one endpoint do not justify ~15 MB of
dependencies in the image.

### Ephemeral, session-validated links

```
browser → GET /api/uploads/<id>        session cookie checked, row scoped by user_sub
        ← 302 http://s3/…?X-Amz-Signature=…   signed, expires in S3_LINK_TTL_SECONDS (300s)
browser → GET that URL                 bytes stream straight from SeaweedFS
```

Messages persist the stable `/api/uploads/<id>` path, never the signed URL, so nothing on
record can expire. The signed URL is minted per request, covers the key and the expiry, and
is rejected by the gateway if either is altered (verified: a tampered signature gets 403).
Node never touches the payload on the read path.

### One quota, two colours

`UPLOAD_QUOTA_BYTES` (1 GiB by default) covers **uploads and chats together**
(`frontend/src/lib/server/storage.ts`):

- **uploads** — `sum(attachments.bytes)`
- **chats** — `octet_length` of message content, agent traces and conversation titles

`octet_length`, not `pg_column_size`: the number is what the user wrote, so it stays stable
when Postgres changes its mind about TOAST compression. Both `POST /api/uploads` and
`POST /api/chat` return **413** with the real figures when the account is full. The settings
dialog renders the split as a stacked bar — orange uploads, green chats, grey remainder.

### Endpoints

- `POST /api/uploads` (multipart) → `{id, url}`; MIME allow-list, per-file cap, quota check.
- `GET /api/uploads` → `{uploads, chats, used, free, quota, files, items}`; `?limit=10`
  backs the composer's "Verlauf" submenu.
- `GET /api/uploads/<id>` → 302 to a fresh presigned URL (above).
- `DELETE /api/uploads/<id>` → deletes the row, then the object; frees quota immediately.
- Messages store `/api/uploads/<id>`; bytes are expanded to a base64 data URL **only** for
  the model call, since the proxy cannot reach our server.
- `attachments.message_id` is `ON DELETE CASCADE`, so deleting a conversation reclaims its
  attachments. Uploads that were never sent still count against quota, so an abandoned
  upload cannot be used to hide storage.

Ordering is chosen so failures degrade in the harmless direction: on write the object goes
first (a stray object is invisible garbage; a row without an object is a broken image), on
delete the row goes first (an orphan object beats a row the user cannot get rid of).

```bash
UPLOAD_QUOTA_BYTES=1073741824   # 1 GiB per user, uploads + chats together
UPLOAD_MAX_FILE_BYTES=10485760  # 10 MiB per file
S3_ENDPOINT=http://seaweed-s3:8333    # reachable from the container
S3_PUBLIC_ENDPOINT=http://localhost:8333  # reachable from the browser (signed for this host)
S3_BUCKET=gsi-uploads
S3_LINK_TTL_SECONDS=300
```

---

## 8b. Knowledge bases and delegated access control

Not every user may see every part of the corpus. The model has **two levels**: an admin
sets what a department may reach at most, and the department's own manager decides who
inside it gets how much of that. Nobody can widen their own reach.

### Roles

| Role | Sees in the account menu | May |
| --- | --- | --- |
| `llmbot-user` | Einstellungen | chat, within their grants |
| `llmbot-privileged` | + **Verwaltung** | set per-member grants inside groups they manage |
| `llmbot-admin` | + **Administration** | create groups, set group ceilings and managers, manage sources/crawls, read the audit log |

Both upper roles are composite over `llmbot-user`. Holding both shows both entries — the
roles are independent, and the menu simply reflects what you hold.

### Where things live

Keycloak is **read-only** to us: it authenticates, issues the roles, and (through a
service account with `view-users` only) answers "who exists in this realm". Everything
about knowledge bases and groups lives in Postgres, where the data it protects lives.

```
Keycloak (read)                Postgres (read/write)
────────────────               ─────────────────────
identity, roles       ──▶      app_users        seen at login / mirrored for the picker
realm user list                groups           name, description
                               group_members    membership + is_manager
                               group_grants     the CEILING, set by an admin
                               member_grants    the SUBSET, set by the manager
                               knowledge_bases  what a grant points at
                               audit_log        who changed what, when
```

Role assignment stays a Keycloak console job — we display roles, never write them. That
keeps the blast radius of our service account to "can list users".

### What a knowledge base is

One row per **Foswiki web** (`wiki:Linux`, `wiki:IT`, … ~28 of them) plus one per
non-wiki source (`virgo-docs`, `www`). `documents.kb_id` is set at crawl time and
backfilled from the URL for the existing corpus, since a Foswiki URL's first path segment
*is* its web. KBs marked `is_default` form the **public baseline** every `llmbot-user`
gets without belonging to any group — a new hire is useful on day one.

### Effective grants

```
effective(user) =  default KBs
                ∪  for each group the user belongs to:
                      restricted?  member_grants(group, user)      ← manager's subset
                      otherwise    group_grants(group)             ← the full ceiling
```

A member starts with the whole ceiling; the manager only ever narrows. `restricted` is an
explicit flag on the membership so "not customised" is distinguishable from "customised to
nothing" — otherwise revoking a manager's last tick would silently restore full access.

**The ceiling is enforced server-side on every write**, not just hidden in the UI: a
manager's request to grant a KB outside `group_grants` is rejected, whatever the client
sends.

### Enforcement at query time

`retrieve()` takes the caller's KB ids and filters both the dense and the lexical arm with
`d.kb_id = ANY(...)`. It is a **hard SQL filter, not a post-filter**: a forbidden chunk
never enters the ranking, so it cannot influence what the model sees or be leaked through
a citation. Deep mode inherits it — subagents are handed the same list as the lead. With
no grants at all the function short-circuits to an empty result and the orchestrator says
so plainly instead of hallucinating.

The composer footer names the knowledge bases being searched ("Durchsucht: Linux, IT,
Main"), so "why does it not know about X?" has a visible answer. Users cannot change it.

### Revocation

Losing a KB hides every conversation that cites it: filtered from the sidebar, 404 on the
URL, and purged with its attachments after `REVOCATION_GRACE_DAYS` (30). Hiding is a row
in `hidden_conversations`, so a mistaken revocation is repairable right up until the purge
runs; after that it is genuinely gone, which is the point of the grace period rather than
an accident of it.

### Audit

Every grant, revoke, membership change, manager change and crawl trigger writes to
`audit_log` with actor, action, target and a JSON detail. It is the first thing anyone
will want the day someone asks "who gave them access?", and it costs one insert.

```bash
KEYCLOAK_BASE_URL=http://keycloak.localhost:8081
KEYCLOAK_REALM=gsi
KEYCLOAK_ADMIN_CLIENT_ID=chat-gsi-de-admin     # service account, view-users only
KEYCLOAK_ADMIN_CLIENT_SECRET=...
REVOCATION_GRACE_DAYS=30
```

---

## 9. Configuration

```bash
# --- GSI LLM proxy (verified paths) ---
LLM_BASE_URL=http://192.168.50.1:8080/api/v1
LLM_API_KEY=pk-praktikum2026
CHAT_MODEL=llmbot.mistral-small-4-119b
CRAWL_MODEL=llmbot.qwen3.6-27b
UTILITY_MODEL=llmbot.gpt-oss-120b
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
EMBEDDING_DIM=4096
LLM_CONTEXT_WINDOW=200000
EMBED_BATCH_SIZE=32

# --- database ---
POSTGRES_HOST=db
POSTGRES_DB=llmbot
POSTGRES_USER=llmbot
POSTGRES_PASSWORD=<secret>

# --- oidc ---
OIDC_ISSUER=http://localhost:8081/realms/gsi
OIDC_CLIENT_ID=chat-gsi-de
OIDC_CLIENT_SECRET=<secret>
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=<secret>

# --- orchestrator ---
MAX_ROUNDS=3
MAX_SUBAGENTS_PER_ROUND=4
DEEP_WALL_CLOCK_BUDGET_S=180
RETRIEVE_TOP_K=40
CONTEXT_CHUNKS_FAST=8
CONTEXT_CHUNKS_DEEP=12

# --- crawler ---
CRAWL_RATE_LIMIT_RPS=1.0
CRAWL_USER_AGENT="gsi-llmbot-crawler/1.0 (+https://chat.gsi.de)"
CRAWL_VISION_ENABLED=true
```

`LLM_API_KEY` is a `podman secret` in prod, never in git.

---

## 10. Repository layout

```
chat.gsi.de/
├── plan.md  info.md  README.md
├── compose.yaml  compose.dev.yaml  compose.prod.yaml
├── .env.example  Makefile  .gitignore
├── db/migrations/          # 001_extensions 002_schema 003_indexes 004_seed
│                           # 005_message_tree 006_attachments 007_attachments_object_store
├── crawler/
│   ├── app/
│   │   ├── main.py         # CLI: crawl / reindex / status
│   │   ├── connectors/     # base.py html_sitemap.py mediawiki.py dokuwiki.py
│   │   ├── extract.py      # html → markdown blocks
│   │   ├── vision.py       # qwen3.6-27b assist
│   │   ├── chunk.py  embed.py  store.py  pipeline.py
│   │   └── config.py
│   └── pyproject.toml  Containerfile
├── frontend/
│   ├── src/
│   │   ├── hooks.server.ts
│   │   ├── lib/server/
│   │   │   ├── oidc.ts session.ts db.ts llm.ts embeddings.ts retrieval.ts
│   │   │   ├── s3.ts storage.ts uploads.ts tree.ts
│   │   │   └── orchestrator/  lead.ts subagent.ts budget.ts prompts.ts
│   │   ├── lib/components/  Chat Message Citation AgentTrace Sidebar ModePicker
│   │   └── routes/          +page  /c/[id]  /auth/*  /api/chat  /api/feedback
│   └── package.json  svelte.config.js  Containerfile
├── deploy/                 # quadlet units, crawl.timer, crawl.service
│   ├── keycloak/realm-gsi.json
│   └── seaweedfs/s3.json   # S3 identity + bucket ACL
└── data/                   # gitignored: corpus/ backups/
```

---

## 11. Phases

1. **Corpus** — compose skeleton, migrations, HTML/sitemap connector on wiki.gsi.de,
   Markdown output, chunking, embedding into pgvector. Done when the corpus is queryable
   in `psql` and the Markdown is readable in an editor.
2. **Retrieval + fast mode** — hybrid search, RRF, `gsi-fast`, SSE, citations.
   Done when `curl` returns a cited answer.
3. **Frontend + auth** — SvelteKit, Keycloak, streaming UI, citation chips, history.
4. **Deep mode** — lead/subagents, budgets, agent trace panel.
5. **Operations** — weekly timer, incremental diffing, deletions, admin endpoints,
   Quadlet units, backups, feedback loop.
6. **Expansion** — www.gsi.de (Typo3) and virgo-docs. Config, not code.

---

## 12. Verified findings (2026-07-27/28)

The wiki-engine question is **answered: wiki.gsi.de runs Foswiki** — the "FOSS Wiki" of
the sketch. Everything below was established by probing the live systems, and each item
is encoded in the code with a comment pointing back here.

**Foswiki**
- No `sitemap.xml`. `WebIndex`, `WebTopicList` and `WebRss` are **login-gated for
  guests** even where content topics are public, so discovery must be a link crawl
  seeded from each web's `WebHome`.
- `?skin=text` returns the topic body without navigation chrome — ~2 KB versus ~8.5 KB
  for the same topic. Every fetch uses it.
- **28 public webs** discovered anonymously (AcceleratorControls, Epics, Linux, ROOT,
  Research, …).
- `robots.txt` sets **`Crawl-delay: 5`**. The connector enforces that floor regardless
  of `CRAWL_RATE_LIMIT_RPS`, so a misconfiguration cannot hammer the wiki.
- Topics can **redirect off-site** (`Linux/BatchFarm` → `www.gsi.de`). The landing host
  is checked explicitly, or the wiki crawl silently starts indexing the public website.

**Access control — resolved, and better than expected**
The wiki states: *"Some webs are restricted and hidden from the list of webs on the
left. Please log in to view them."* Restricted webs are absent from the anonymous web
list and serve a login page instead of content. **Anonymity is therefore the ACL
enforcement mechanism**, and the crawler must never be given wiki credentials. A
restricted topic raises `PermissionError`, is counted separately, and is not an error.

**LLM proxy**
- Chat and embeddings both live under `/api/v1`. `info.md`'s `/api/chat/completions`
  returns **403**.
- `Qwen/Qwen3-Embedding-8B` is available (hidden in the model list), **4096 dims**,
  batch of 32 in 0.6 s.
- The proxy **advertises a `Content-Encoding` it does not apply** — any client offering
  compression dies with `Error -3 while decompressing data`. All three clients send
  `Accept-Encoding: identity`.
- Sporadic **502s under load** (2 of 5 pages in the first trial). All calls are wrapped
  in exponential backoff with jitter; a full crawl would not survive otherwise.

**pgvector — the constraint that shaped retrieval**
HNSW refuses more than **2000 dims for `vector`** and **4000 for `halfvec`**. 4096
exceeds both, and this vLLM build rejects the `dimensions` parameter
(*"does not support Matryoshka embeddings"*). Dense retrieval therefore runs as an
**exact sequential scan** — perfect recall, no approximation, fine at one wiki's scale.
Client-side MRL truncation was measured as the scaling path: at 2048, 1024 and even 512
dims the **top-4 ranking was identical** to full 4096. `db/migrations/003_indexes.sql`
carries the ready-to-run ANN migration.

**Extraction**
LLM-first via `llmbot.qwen3.6-27b`, ~20 s per changed page. Far better output than
heuristics (correct titles, TOC stripped, absolute URLs, inline code preserved). Two
guards proved necessary: the model returns `EMPTY` for real content pages, so that
verdict is only believed when the deterministic parser also finds little; and a
suspiciously short result falls back to the parser.

**Frontend / OIDC integration (2026-07-28)**
- **Split-horizon issuer solved with `keycloak.localhost`.** The browser and the
  frontend container must use the *same* issuer URL or OIDC validation fails. The host
  resolves `*.localhost` to 127.0.0.1 (where Keycloak's port is published) and a compose
  **network alias** makes the same name resolve to the container inside the network. No
  `/etc/hosts` edit needed.
- **`openid-client` v6 refuses plain HTTP.** Relaxed *only* when the configured issuer is
  itself `http://` — a production `https://` issuer keeps full enforcement.
- **`redirect_uri` must be sent explicitly** on the token exchange. Derived from the
  request URL it mismatches behind a proxy, and Keycloak rejects with
  `invalid_grant: Incorrect redirect_uri`. `ORIGIN` is also pinned for adapter-node.
- **Config and clients must be lazy.** SvelteKit's build analysis imports server modules
  with no environment, so eagerly reading env or opening the Postgres/Valkey connection
  breaks `vite build`. `config.ts` uses getters; `db.ts` and `session.ts` connect on
  first use.
- **Keycloak sets `Secure; SameSite=None` cookies even over HTTP.** Browsers accept these
  on `*.localhost` (a "potentially trustworthy origin"); `curl` and `httpx` do **not**,
  so scripted login tests must replay cookies manually. This is a test-harness caveat,
  not an app bug — but it is another reason production must be HTTPS end to end.

**Svelte 5 reactivity — the reason streaming looked broken (2026-07-28)**
The SSE backend was streaming correctly all along (measured: 91 token events over 0.52 s),
but the UI never repainted. Cause: `chat.svelte.ts` pushed a message object into a
`$state` array and then mutated **that same raw object**. Svelte 5 stores the raw value
and hands out a proxy on read, so writes to the original reference bypass the proxy's
setter and no reactivity fires. Fix: read the element back out of the array
(`this.messages[this.messages.length - 1]`) and mutate the proxy. Worth remembering — it
is silent, and it looks exactly like a broken backend.

**Message branching (2026-07-28)**
Editing an earlier message must not destroy the answer it already produced, so messages
form a **tree**, not a list (`db/migrations/005_message_tree.sql`). An edit inserts a
*sibling* of the original message; the reply becomes that sibling's child. The
conversation renders the path from `conversations.active_leaf_id` up to the root, so the
selected branch survives a reload, and the `< n / m >` control simply moves between
siblings at one depth. `src/lib/server/tree.ts` does the walk in a single recursive CTE
rather than N round-trips.

### Status

Whole stack runs under `podman compose`: db, valkey, keycloak, frontend healthy;
crawler as a batch job.

- **Corpus** — 6 pages → 42 chunks → 4096-dim vectors, 0 failures.
- **Retrieval** — *"How do I reset my forgotten GSI Linux password?"* puts the correct
  chunk at rank 1 (distance 0.226, next 0.408).
- **Auth** — full Authorization Code + PKCE flow against Keycloak as `testuser`, opaque
  server-side session, roles enforced.
- **Fast mode** — grounded, cited answer in **0.6 s**, citations deep-link to
  `wiki.gsi.de/...#anchor`.
- **Deep mode** — 2 rounds / 5 subagents in **5.4 s**, stopped early instead of burning
  round 3, shared citation pool deduplicated 13 chunks.
- **UI** — shadcn-svelte, light/dark/system, markdown answers with citation chips,
  German question → German answer. First token at **0.27 s**.
- **History & titles** — conversation list, reload restores citations *and* the deep-mode
  agent trace (verified: 20 citations, 12 subagents restored). Model-suggested title:
  `"GSI Linux-Passwort zurücksetzen"`.
- **Branching** — edited a follow-up, saw `[2/2]`, switched back to `[1/2]` and got the
  original answer unchanged.
- **Uploads on object storage** (2026-07-28) — upload → SeaweedFS → `/api/uploads/<id>`
  → 302 → presigned fetch returned byte-identical content; a tampered signature got
  **403**; delete removed both the row and the object (verified against the filer listing).
  A vision turn with an attachment pulled the bytes back out of SeaweedFS and answered.
  Usage reported `uploads` and `chats` separately against one 1 GiB quota.
- **Access control** (2026-07-28) — three accounts, three roles, one script: role gates
  hold (`normaluser` 403 on both areas, `manager` 403 on /admin, 200 on /management); a
  manager sees only their ceiling and was **refused 403** when granting outside it; a
  question about a forbidden knowledge base retrieved **only** from the granted one
  (checked against `documents.kb_id`, not against the answer text); revoking hid 5
  conversations and re-granting brought all 5 back; the audit log recorded every step.
- **Types** — `svelte-check` clean (0 errors).

Not yet written: `compose.dev.yaml` / `compose.prod.yaml` overlays and the Caddy `proxy`
service (§3 lists them; only `compose.yaml` exists so far).

### Incident: the crawl sweep, 2026-07-28

A `--skip-existing` run against an unreachable web list discovered zero pages, and
`sweep_deleted()` then soft-deleted all **145 documents** and dropped every chunk — the
whole corpus, on the strength of a network error. Two root causes, both fixed:

1. `FoswikiConnector.__init__` had lost `self._http` and `self._exclude_webs` in an edit,
   so every fetch raised inside a broad `except` and returned `None`. Discovery silently
   yielded nothing instead of failing.
2. The sweep ran unconditionally. **An empty discovery is a failure, not an empty wiki** —
   it now skips the sweep, marks the run `failed`, and says so.

Recovery cost nothing but embeddings: `documents.markdown` still held every page, so
`make reindex-restore` (new: `crawler reindex --undelete`) rebuilt 437 chunks locally
without touching the wiki. That the corpus is recoverable from the database alone is worth
keeping — it is the reason a bad sweep is an inconvenience rather than a day of crawling.

### Remaining risks

| Risk | Mitigation |
|---|---|
| Full first crawl is slow (~5 s crawl delay + ~20 s LLM extraction per page) | Only *changed* pages pay extraction; parallelise extraction if the first run is unacceptable |
| 32k context is small for 4 parallel subagents | Lead sees findings only, never raw chunks; budget enforced per subagent |
| Proxy is a praktikum service — may rate-limit or vanish | All LLM access behind `lib/server/llm.ts`; swapping to the real `llmbot.gsi.de` is a base-URL change |
| Exact scan slows as the corpus grows | Measure at ~50k chunks; enable the halfvec(2048) ANN index in migration 003 |
| Vision calls make recrawls expensive | Opt-in per page via extractor confidence, not blanket |
| Dev box has ~2 GB free RAM | Keycloak heap capped; `make dev-noauth` stub for low-memory work |
| **Wiki access control** | v1 indexes only wiki content readable by all staff. Per-document ACLs are **out of scope for v1** — restricted spaces must be excluded at crawl time. |
| Presigned links leave the session boundary once minted | TTL is 300 s and the URL is minted per request; nothing durable stores a signed URL |
| A single SeaweedFS volume server is a single point of failure | Scale with `--scale seaweed-volume=N` and add `-replication=001` once there is more than one host |
| A stale `member_grants` row could outlive a narrowed ceiling | The ceiling is re-intersected on **read** as well as on write, so narrowing a group takes effect immediately for everyone in it |
| Managers are only as trustworthy as the ceiling they are given | A manager can never widen their own group; widening is an admin action and every change is in `audit_log` |
| Objects can outlive their row if a delete half-fails | Deliberate direction (an orphan object, never a broken image); a prefix sweep against `attachments.object_key` reclaims them |

The access-control risk that opened this plan is now closed by construction rather than
by a maintained exclusion list, which is the far safer arrangement: if a web is
restricted, the crawler simply cannot see it.
