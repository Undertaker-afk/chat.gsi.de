# The documents agent

Searches the places the crawler cannot reach — **indico.gsi.de**,
**repository.gsi.de**, and PDFs that crawled pages link to but that were never
themselves crawled — and reads what it finds.

```
frontend/src/lib/server/
  sources/indico.ts       Indico search API
  sources/repository.ts   Invenio RSS + OAI-PMH
  sources/documents.ts    fetch → cache → extract text
  fetchdoc.ts             the shared egress boundary (also used by /api/pdf)
  orchestrator/docsagent.ts
```

## It runs on every turn

That is the unusual property, and it is deliberate.

A planner deciding "does this question need Indico?" would have to know what is
in Indico to answer. The image agent *can* be gated on intent — wanting a picture
is visible in the question ("zeig mir", "wie sieht … aus") — but wanting a slide
deck from a 2021 collaboration meeting is not.

It is affordable because it is **off the critical path**: started before
retrieval, awaited just before the answer is written. On a normal turn it costs
no wall-clock at all, because the corpus work it runs alongside takes longer.

And it **cannot fail a turn**. Every path returns a result object; nothing throws
past `runDocumentsAgent`. An answer without external documents is fine. An answer
that failed because indico.gsi.de was slow is not.

Turn it off with `DOCS_AGENT_ENABLED=false`. That is a real switch, not a flag
awaiting removal — this is the one part of a turn that reaches hosts we do not
operate, and stopping that should not need a redeploy.

## The pipeline

```
question
  → searchTerms()      keyword query + a one-word fallback     (utility model)
  → 3 searches         Indico ∥ repository ∥ corpus links      (parallel)
  → broaden once       if the first query matched nothing
  → pick()             which are worth downloading             (utility model)
  → readDocument()     ≤3 fetches, cached, text-extracted      (parallel)
  → read()             summary with markers                    (chat model)
  → the lead           findings + numbered sources, never the document text
```

The context discipline matches the rest of the orchestrator: **the lead never
sees the fetched document text.** It sees the agent's summary and a numbered source
list, exactly as it does for research subagents.

## What each source actually gives you

| Source | Search | Full text? |
|---|---|---|
| **Indico** | `/search/api/search` | **yes** — PDF and Office files fetched and extracted |
| **repository.gsi.de** | `/rss?p=` | **no** — bibliographic pointer only |
| **corpus links** | `document_links` (migration 015) | yes, where the link is a live document |

### Indico

Verified against indico.gsi.de on 2026-07-30:

- **`type` is required.** Omitting it is a 422 with an *HTML* body, so a caller
  that forgets gets a JSON parse failure and no clue why.
- Useful types are `attachment`, `event`, `event_note`. **`contribution` and
  `subcontribution` are accepted and return zero results for every query tried**
  (FIDIUM, LHCb, CBM) — they are not indexed on this instance. Do not add them
  back; they cost a request and return nothing.
- `total` is `-1`, meaning "not counted". It is not a result count and must never
  be rendered as one.
- `pagenav.next` is an **opaque cursor** passed back as `page=`. It is not a page
  number — `page=1` is a 422.

The older `/export/event/<id>.json` API (docs.getindico.io) works anonymously and
is a fine *export* interface, but it has **no full-text search**: you must
already know the event id. That is why the newer search API is used instead.

### repository.gsi.de — the constraint that shapes the module

`/search`, `/record/<id>` and `/record/<id>/files/*.pdf` are **all behind a
JavaScript bot challenge**. They answer 200 with a 248-byte stub loading
`/fast-challenge/index.js`, and that script explicitly penalises automation:

```js
if (navigator.webdriver) timeout_incr += 10000;
if (navigator.plugins.length === 0) timeout_incr += 5000;
```

Verified across three retries, with and without a browser User-Agent, with and
without the `INVENIOSESSION` cookie from the homepage. `of=recjson`, `of=xm` and
`of=id` are all challenged too, so the documented Invenio output formats are
simply unreachable.

**We do not try to defeat it.** The operator has drawn a line, and the two
interfaces they left open are exactly the ones meant for machines:

| Endpoint | Status |
|---|---|
| `/rss?p=<query>` | 200 `application/rss+xml` — full-text search |
| `/oai2d?verb=…` | 200 — OAI-PMH metadata |

There is also **no abstract available anywhere**. Records 183915, 368909, 368907
and 368893 all carry zero `dc:description` elements, and `marcxml` has no 520
summary field. So a repository result is title, authors, publication reference
and a link — a *pointer*, not evidence.

Everything downstream marks these `read: false`. The prompt forbids the model
from saying anything about their contents, the trace shows **"nur Metadaten"** in
amber, and the source chip carries the same label. A reader must never mistake a
citation for something we read.

## Keyword extraction is not optional

**This is the bug that shipped in the first version.** Passing the question
through unchanged found nothing, silently, on every turn — the search succeeded
and returned an empty list.

Indico and Invenio are AND-based keyword indexes. Measured:

| Query | Attachments |
|---|---|
| `Was macht das CBM Experiment?` | **0** |
| `CBM Experiment` | 3 |
| `CBM` | 10 |

Every extra word throws results away. `searchTerms()` therefore asks the utility
model for 2–3 terms plus a single-term fallback, with a stopword-stripping
heuristic if that call fails. If the search finds nothing, it **broadens once** to
the fallback term.

It is exactly the trap the image agent's `image_query` prompt already documents
for media.gsi.de. Same index semantics, same failure, and it is silent both
times.

## Fetching goes through the existing boundary

Nothing here is a second, weaker egress path:

- **`pdfscope.assertFetchable`** decides whether a URL may be fetched. Both
  `indico.gsi.de` and `repository.gsi.de` are under `gsi.de`, so they were
  already allowed; corpus links are allowed because the crawler produced them.
- **`fetchdoc.follow`** re-checks every redirect hop against internal addresses.
- **`externalcache.cachedDocument`** means a PDF a user opened in the viewer this
  morning costs the agent nothing this afternoon — and vice versa.

`fetchdoc.ts` was extracted from `/api/pdf` rather than copied. It is the egress
boundary; two copies would drift, and a fix applied to one and not the other is
how that kind of code rots.

### Extraction

Two extractors in `sources/extract.ts`, chosen by MIME type:

| Format | Library |
|---|---|
| PDF | `unpdf` (pure-JS pdf.js) |
| pptx, docx, xlsx, odp, odt, ods | `officeparser` |

**`officeparser` rather than `markit-ai`**, which was the other candidate:
markit-ai is an LLM-assisted converter, and we already pay for a model call per
document to judge relevance. A second one to convert would double the agent's
cost for text officeparser produces deterministically and offline. Putting an LLM
in the *extraction* path also means a document's contents can be paraphrased
before anyone sees them — the wrong place for that in a system whose whole claim
is that answers trace back to sources.

`parseOffice()` returns a document **object**, not a string; `.toText()` is what
yields the flat text. Verified against a 10 MB CBM deck from Indico: 12069
characters, 0 warnings. Flat text is what we want — slide layout carries no
meaning once it is in a model's context.

Supporting Office formats mattered more than it sounds: **Indico is mostly
`.pptx`**, so a PDF-only reader threw away the format the site is made of. Decks
that previously showed as *nur Metadaten* are now read.

`unpdf` logs `Math.sumPrecise is not a function` warnings on Node < 24 — harmless
polyfill noise, extraction succeeds.

## Triage must know that pointers are cheap

`DOCS_PICK_SYSTEM` originally said *"each pick is a real download"*. True for
Indico and corpus links; **false for repository records**, which are never
downloaded at all.

The effect was that the triage model refused every repository candidate, and the
repository path produced a citation exactly never — including for a question that
asked outright which publications exist on a topic, with seven matching records
in front of it. The prompt now states which origins cost a download and which do
not.

Worth remembering as a class of bug: a triage prompt that describes the wrong
cost model rejects correctly-retrieved candidates, and it looks identical to the
search having found nothing.

The same area had a second, independent bug. `pick()`'s fallback — used when the
utility model returns unparseable JSON, which **gpt-oss does whenever the token
budget goes to reasoning and it answers `content: null`** — filtered candidates
to `readable`. Repository records are never readable, so a triage failure on an
all-repository candidate list returned *nothing*, and that is again
indistinguishable from "triage rejected everything".

Both were only findable because the agent logs its funnel. It had none at first,
and that cost a debugging round of pure guesswork. Every early return now logs:

```json
{"msg":"documents agent picked nothing","query":"Publikationen Polarimeter","candidates":7}
```

## Reading a source in the UI

A source the panel can render — PDF, pptx, docx, xlsx and the OpenDocument
equivalents — opens **in the side panel**, not a new tab. Losing the conversation
to read a source is the wrong trade, and the panel is the only place these load
at all: indico.gsi.de sends no CORS headers, so the bytes come through
`/api/pdf` either way.

Anything else — a repository record, an Indico event page — is a web page with
nothing to render, and still opens in a tab.

`/api/pdf` keeps its name for history but now serves the same MIME allowlist the
extractor uses (`EXTRACTABLE`). Sharing that map is deliberate: a link the viewer
intercepts but the proxy refuses would be a dead end.

Presentations render through `pptxviewjs` in `SlideViewer.svelte`. That library
draws **one slide to a canvas at a time** — there is no scrolling document view —
so the paging control is ours. It is loaded lazily and client-only, like
svelte-pdf, and a deck it cannot render falls back to "Original öffnen".

## Citations

External sources continue the corpus numbering, so a reader gets one source list.

They **cannot** be stored in the `citations` table: its `chunk_id` is a foreign
key into `chunks`, and an Indico PDF has no chunk. They are persisted in the
message trace instead — the same route the chosen image already takes — and the
marker travels with each source rather than being recomputed on reload. Deriving
it from a count would break the moment a corpus chunk is swept.

**Both halves are rebuilt in `$lib/server/messages.ts`**, which is the single
shaper for every stored message. It is shared rather than duplicated because the
duplicate had already drifted: the conversation route rebuilt agents, image and
suggestions while the branch route returned none of them, so switching to an
older version of a question silently stripped its whole trace. The documents
agent did not cause that; it just made it visible.

No migration was needed for any of this. The trace was always written correctly —
the bug was purely on the read path, and conversations recorded before the fix
rehydrate in full once it is deployed.

## Metrics

| Metric | Watch for |
|---|---|
| `chatgsi_external_searches_total{source,outcome}` | **`outcome="challenged"`** — repository.gsi.de started serving its bot challenge on RSS too, which otherwise looks exactly like "no results" |
| `chatgsi_external_hits_total{source}` | hits per search |
| `chatgsi_document_agent_runs_total{outcome}` | `nothing_relevant` is the expected majority, not a fault |
| `chatgsi_document_reads_total{outcome}` | `fetched` vs `cached` vs `unreadable` |
| `chatgsi_document_read_duration_seconds` | |
| `chatgsi_document_pages` | |

The funnel is the point: searches → hits → picked → read. A drop between any two
stages is a different problem.

> No Grafana panels exist for these yet. The metrics are exposed and correct;
> the dashboards have not been extended.

## Testing it

```bash
# Can the POD reach the sources? (Different question from the dev box.)
kubectl -n chat-gsi exec deployment/frontend -- node -e "
  fetch('https://indico.gsi.de/search/api/search?q=CBM&type=attachment')
    .then(r => r.json()).then(j => console.log(j.results.length))"
```

Then a real turn, and check the `documents` SSE event. **`state: "none"` with
`searched: 0` after a question containing an obvious acronym means keyword
extraction is broken** — that is the silent failure to watch for, and it looks
identical to "Indico genuinely has nothing".

Things worth verifying deliberately:

- A repository citation must render **"nur Metadaten"** and the answer must not
  claim anything about its contents.
- A question with no proper noun should produce `outcome="no_query"` and no
  searches at all.
- Turning `DOCS_AGENT_ENABLED=false` must leave answers otherwise unchanged.
