# Crawler

Python 3.12, no framework. `crawler/app/`.

```
main.py        CLI: crawl | tick | reindex | status | check
pipeline.py    the run loop, the Controller, the delete sweep
store.py       every SQL statement
connectors/    base.py (protocol, conditional headers) + foswiki.py, html_sitemap.py
extract.py     deterministic HTML → Markdown
llm_extract.py model-assisted extraction, when the deterministic one is not confident
vision.py      figure descriptions
chunk.py       heading-aware splitting
scope.py       what is in and out of a source
```

## CLI

```bash
crawler crawl [--source SLUG] [--mode MODE] [--force] [--skip-existing] [--requested]
crawler tick                 # what the CronJob runs: reap → claim → schedule
crawler reindex [--undelete] # rebuild chunks+embeddings from stored Markdown
crawler status               # recent runs
crawler check                # LLM proxy reachability + embedding dimensions
```

`reindex` needs no network access to the sources — it rebuilds from the Markdown
already in the database. That is the right tool after an embedding-model change or
a chunking change, and it is much cheaper than `--mode full`.

## The pipeline

```
discover ──▶ for each page:
               revision known and unchanged?  ─▶ skip, no request        (changed-only)
               conditional GET ─▶ 304?        ─▶ touch, skip processing  (changed-only)
               fetch ─▶ extract ─▶ hash
               hash unchanged?                ─▶ touch, skip embedding
               changed ─▶ chunk ─▶ embed ─▶ replace chunks in one transaction
            end of run:
               documents not seen this run ─▶ deleted_at, chunks dropped
```

A page costs roughly 28 seconds end to end. A 304 still pays the crawl delay but
skips extraction, chunking and embedding — about 27 of those 28 seconds.

### The delete sweep is the dangerous part

Two guards, both of which have prevented real data loss:

1. **A run that saw zero pages never sweeps.** A failed discovery would otherwise
   mark the entire corpus deleted.
2. **A stopped run never sweeps.** It only saw the pages before the button was
   pressed; everything after would look deleted.

```python
if stopped:
    log.warning("[%s] stopped -- skipping the delete sweep", pageslug)
elif stats.seen > 0:
    stats.deleted = db.sweep_deleted(source["id"], run_id)
```

Verified: stopping a wiki crawl at 202 of ~460 pages deleted **nothing**. Re-verify
after any change to `pipeline.py` — the failure is silent and destroys data.

Deletion is soft (`deleted_at`), and `reindex --undelete` brings documents back.

## Modes

| Mode | Behaviour |
|---|---|
| `incremental` | fetch everything, compare content hashes (the historical default) |
| `changed-only` | skip the fetch, or the processing, when the source says nothing changed |
| `full` | re-embed everything regardless |
| `skip-existing` | never revisit a known page; fast, blind to edits |

### changed-only

Two steps. A sitemap `<lastmod>` matching what we stored skips the request
entirely. Otherwise a conditional GET goes out and a **304** means unchanged.

**Absence of a validator always means "fetch it", never "assume unchanged."**
Getting that backwards silently freezes the corpus with no error anywhere.

Whether it pays off is a property of the server:

| Source | Validators | Effect |
|---|---|---|
| `virgo-docs` | ETag + Last-Modified | full benefit — **41 pages, 40 skipped, 205 s → 5 s** |
| `www` | sitemap `<lastmod>` | request skipped when lastmod matches |
| `wiki` | **none** | falls back to a normal incremental crawl |

`wiki.gsi.de` sends neither validator, so `changed-only` is a safe no-op there.
Correct fallback, not a bug — but do not expect it to speed up the wiki.

### Why changed-only silently did nothing

Three independent bugs, all silent, all worth knowing before touching this code:

1. **`touch()` did not record the validator.** A page that never changes is never
   upserted — so the pages `changed-only` exists to skip were exactly the pages
   that never got a validator. `touch()` now refreshes them with `COALESCE`.
2. **Apache's `mod_deflate` appends `-gzip` to the ETag *after* evaluating
   `If-None-Match`.** A client that faithfully echoes the ETag it was given never
   matches and gets 200 forever. Proved by experiment: stored form → 200, stripped
   form → 304, both → 304. `If-None-Match` takes a list, so `_conditional_headers()`
   sends both.
3. **Discovery URLs and stored URLs differ across a redirect.** virgo-docs is
   listed under `hpc.gsi.de/virgo/…` and stored under `virgo-docs.hpc.gsi.de/…`.
   The content-hash check never noticed because it runs *after* the fetch; the
   revision check runs *before* it and missed every time. Hence
   `documents.discovered_url` (migration 019), and the revision lookups key on
   `coalesce(discovered_url, url)`.

The payoff needs one full run first to populate validators. The admin UI shows
"N mit Revision" so that warm-up is visible rather than mysterious.

## The control plane

The frontend cannot start a process. It writes intent; `tick` acts on it.

```
crawl_control     desired_state, stop_requested_at, interval_minutes, mode, next_run_at
crawl_requests    one pending request per source
crawl_runs        per-run counters, mode, status, heartbeat_at, requested_by
```

`crawler tick` runs every five minutes (`k8s/51-crawler-cron.yaml`) and does three
things in order:

1. **Reap** runs whose heartbeat has gone stale. A run left `running` by a killed
   pod blocks every future scheduled crawl of that source, so this goes first.
2. **Claim** queued admin requests.
3. **Start** any source whose interval has come round.

It **dispatches** rather than crawls: each crawl becomes its own Job, cloned from
the tick's own `jobTemplate` (`crawler/app/dispatch.py`), and the tick exits in
well under a second every time — including when there is work to do.

### Why the tick does not crawl inline any more

It used to, and combined with `concurrencyPolicy: Forbid` that made the scheduler
stall behind its own work. A first full crawl of `www` ran for three hours; for
all three hours every tick was refused with `JobAlreadyActive`, so **no queued
admin request could be claimed** — the admin UI's "crawl now" did nothing and the
dashboard's *oldest queued* climbed without bound, while `kubectl get cronjob`
showed a healthy schedule and an active job. The failure was invisible from every
angle except the queue age.

Dispatching separates the two jobs that were tangled together: scheduling must be
prompt and bounded, crawling is long and unbounded. `Forbid` is still set, but now
it guards a sub-second process.

Two crawls of one source are still prevented — by the database, which is where
that guarantee belongs:

* `claim_crawl_requests()` claims with `UPDATE … RETURNING`, so two ticks cannot
  take the same request;
* `due_schedules()` skips sources with a run already `running`, and the tick
  advances `next_run_at` *before* dispatching.

Concurrency is therefore bounded by the number of sources, not by timer frequency.

The dispatched Job carries `--request-id`, so it closes the `crawl_requests` row
itself and the admin UI still sees the request finish. It sets `backoffLimit: 0`:
a Kubernetes-level retry would start a second crawl of the same source behind the
database's back, and the stale-run reaper is the intended recovery path instead.

**Outside Kubernetes** (compose, a local checkout) there is no service account,
`Dispatcher.available` is False, and `tick` crawls inline exactly as before. The
RBAC it needs in-cluster is `get` on cronjobs and `create` on jobs, and nothing
else — the Role is in `k8s/51-crawler-cron.yaml`.

### Pause and stop

The `Controller` polls `crawl_control` (throttled to 5 s) and `checkpoint()` blocks
while paused. Both take effect **at a page boundary** — the only place where no
request is in flight and no document is half-written.

A stop is a **timestamp**, and the crawler ignores any stop older than its own
start. Otherwise a stop pressed against nothing running would lie in wait and kill
an unrelated run an hour later. It is cleared by the crawler, never by the UI.

A heartbeat thread writes `heartbeat_at` so the admin UI can distinguish "paused"
(counter stalled, heartbeat fresh) from "crashed" (counter stalled, heartbeat
stale). Check both together or the distinction is lost.

## Extraction

Deterministic extraction runs first. The crawl model (`llmbot.qwen3.6-27b`) is
invoked **only** when the extractor's confidence heuristic fails — a very low
text-to-markup ratio, or `<img>` with no meaningful `alt`. Blanket model
extraction would cost thousands of vision calls on a full recrawl.

The model handles three things HTML parsing does badly:

- **layout-heavy pages** where readability heuristics produce mush
- **figures** — a description goes into an HTML comment beside the image and is
  **embedded with the chunk**, so "what does the cooling infrastructure look like"
  can retrieve a diagram
- **screenshot-only tables**, which become real Markdown tables

Output is one Markdown file per page with YAML frontmatter (url, title, source,
`crawled_at`, `content_hash`, lang, headings), plus a `manifest.json` per source.
The corpus is inspectable in a plain editor and diffable in git — that is the
reason for the format, along with the fact that `heading_path` is one of the
strongest retrieval signals available and flat text destroys it.

## Chunking

- Split on heading boundaries; sections under ~1200 tokens stay whole.
- Oversized sections split on paragraph boundaries with ~15% overlap.
- **Code blocks and tables are never split mid-block.**
- At embed time each chunk is prefixed with its heading path
  (`Access › Key Authentication`) so the vector carries context — stripped before
  the LLM sees it.
- Target 512 tokens, hard ceiling 1024.

## Politeness

`robots.txt` is honoured. `wiki.gsi.de` sets `Crawl-delay: 5` and the Foswiki
connector enforces that floor **regardless of `CRAWL_RATE_LIMIT_RPS`**. Do not
"optimise" this away; it is the reason we are allowed to crawl at all.

`User-Agent: gsi-llmbot-crawler/1.0 (+https://chat.gsi.de)`.

## Adding a connector

Implement the `Connector` protocol in `connectors/base.py`:

```python
class Connector(Protocol):
    def discover(self) -> Iterable[PageRef]: ...
    def fetch(self, ref: PageRef, known_revision: str | None = None) -> RawPage: ...
    def supports_incremental(self) -> bool: ...
    def changed_since(self, since: datetime) -> Iterable[PageRef]: ...
```

Then set `sources.connector` on the source row. Two exist:

- **`HtmlSitemapConnector`** — sitemap first, link crawl as a fallback. Works
  anywhere.
- **`FoswikiConnector`** — discovers webs, filters non-content URLs, detects login
  pages (a login page indexes beautifully and is worthless).

`fetch()` should raise `NotModified` on a 304 rather than returning an empty page,
and should use `_conditional_headers()` so it inherits the `-gzip` ETag
workaround.
