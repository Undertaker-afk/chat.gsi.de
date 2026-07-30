# API reference

All routes are SvelteKit `+server.ts` handlers under `frontend/src/routes/`.
Everything except `/health` and `/metrics` requires a session; role checks are
enforced server-side on every route, not merely reflected in the UI.

## Public

| Route | Method | |
|---|---|---|
| `/health` | GET | `{"status":"ok"}`, or 503 `degraded` if the database is unreachable. `SELECT 1` — deliberately shallow: it answers "can this pod serve", not "is the system healthy". |
| `/metrics` | GET | Prometheus exposition, `text/plain; version=0.0.4`. Optional `Bearer` if `METRICS_TOKEN` is set. |

Both are excluded from the access log at the source — two probes would otherwise be
~20k lines a day.

## Auth

| Route | Method | |
|---|---|---|
| `/login` | GET | redirect to Keycloak authorize; PKCE verifier in a signed cookie |
| `/auth/callback` | GET | exchange the code, create a Valkey session, set an opaque httpOnly cookie |
| `/logout` | GET | clear the session and hit Keycloak's `end_session_endpoint` |

Tokens never reach the browser.

## Chat

### `POST /api/chat` — SSE

The main endpoint. Request carries the message, the mode (`gsi-fast` / `gsi-deep`),
the conversation id and any attachment references.

```
event: status    {"phase":"retrieving","round":1}
event: agent     {"id":"sub-2","query":"…","state":"running"}
event: agent     {"id":"sub-2","state":"done","findings":2}
event: token     {"text":"Slurm "}
event: documents {"state":"found","searched":12,"read":1,"sources":[…]}
event: citation  {"marker":3,"url":"…","title":"…","heading":"Access › Key Authentication"}
event: citation  {"marker":9,"url":"…","external":{"origin":"indico","read":true}}
event: title     {"title":"Slurm job submission"}
event: done      {"message_id":"…","usage":{…},"partial":false}
```

- `agent` events only in deep mode. They are what make a 40-second wait legible.
- `documents` on **every** turn, in both modes — the external documents agent.
  `state: "none"` is the common case and is reported rather than omitted, so
  "we looked and found nothing" is distinguishable from "it never ran".
- A `citation` carrying `external` instead of `chunkId` is a source outside the
  corpus. `external.read: false` means only its metadata was available, never the
  document — see [Documents agent](documents-agent.md).
- `title` arrives *after* the answer — generating it earlier would delay time to
  first token.
- `partial: true` means the wall-clock budget ran out and the answer is built from
  whatever findings existed.
- **413** when the account's quota is full, with the real figures in the body.

Retrieval is filtered to the caller's knowledge bases inside the SQL. Sub-agents
receive the same list as the lead.

## Conversations

| Route | Method | |
|---|---|---|
| `/api/conversations` | GET | the sidebar list, grouped by recency |
| `/api/conversations/[id]` | GET, PATCH, DELETE | fetch, rename, delete |
| `/api/conversations/[id]/branch` | POST | edit a message → new branch; the old one stays intact |

Both return messages through one shaper (`$lib/server/messages.ts`). Anything
derived from the stored trace — the agent trace, the chosen image, the documents
agent's sources and the external citations rebuilt from them — comes back on
every read. Returning a thinner shape from one of the two is what previously made
a reloaded or version-switched answer lose its trace.

A conversation citing a revoked knowledge base 404s and disappears from the list.
It is hidden, not deleted, for `REVOCATION_GRACE_DAYS`.

## Uploads

| Route | Method | |
|---|---|---|
| `/api/uploads` | POST | multipart → `{id, url}`. MIME allow-list, per-file cap, quota check. |
| `/api/uploads` | GET | `{uploads, chats, used, free, quota, files, items}`; `?limit=10` backs the composer's Verlauf submenu |
| `/api/uploads/[id]` | GET | **302** to a freshly presigned URL |
| `/api/uploads/[id]` | DELETE | row first, then the object |
| `/api/media/[id]` | GET | inline media |

The 302 target is signed per request and expires after `S3_LINK_TTL_SECONDS`
(300). Messages persist `/api/uploads/<id>`, never the signed URL, so nothing on
record can expire. A tampered signature gets 403 from the gateway.

Attachments reach the model by two different routes, and conflating them is what
made an uploaded PDF unreadable:

- **images** → base64 data URL, straight to the vision model;
- **documents** (PDF, pptx, docx, xlsx, odp/odt/ods) → text, extracted
  server-side by the same `sources/extract.ts` the documents agent uses, then
  passed as an attached file. A vision model handed
  `data:application/pdf;base64,…` reads nothing.

Bytes are expanded **only** for the model call, since the proxy cannot reach our
server.

> **`UPLOAD_MAX_FILE_BYTES` is not the whole story.** adapter-node caps request
> bodies itself and defaults to **512 K**, so the app limit was unreachable and
> anything larger was refused before the route ran. `BODY_SIZE_LIMIT` on the
> Deployment must stay comfortably above the app limit — otherwise the socket
> closes and the user sees a broken upload instead of a 413 with real figures.

## Generated files

| Route | Method | |
|---|---|---|
| `/api/files` | GET, POST | list; create from an assistant message |
| `/api/files/[id]` | GET, DELETE | content; delete |
| `/api/files/edit` | POST | apply an edit |

Generated files survive the conversation that produced them (migration 016).

## PDF proxy

`GET /api/pdf` fetches a PDF linked from an answer and caches it
(`external_cache`, migration 014).

Every check lives in `lib/server/pdfscope.ts` and all of them apply
(`assertFetchable`), because without them this is an open SSRF proxy sitting inside
the lab subnet:

- a host allowlist (`*.gsi.de`), **and**
- membership in `document_links` (migration 015) — a URL the corpus actually links
  to, so the allowlist is decided by crawled data rather than a hand-maintained
  list;
- `assertPublicHost` on every hop, which is what stops an allowlisted host from
  redirecting the proxy at something internal;
- the response must really be `application/pdf`, and it is size-capped.

Validation happens *inside* the cache-miss path, so nothing reaches storage that
has not been checked.

## Admin (`llmbot-admin`)

| Route | Method | |
|---|---|---|
| `/api/admin/groups` | GET, POST | list, create |
| `/api/admin/groups/[id]` | GET, DELETE | |
| `/api/admin/groups/[id]/members` | POST, PATCH, DELETE | add, set manager flag, remove |
| `/api/admin/groups/[id]/grants` | PUT | set the group's **ceiling** |
| `/api/admin/knowledge-bases` | PUT, PATCH | `is_default` and metadata |
| `/api/admin/users` | GET | realm users, via the read-only Keycloak service account |
| `/api/admin/sources` | GET, PATCH, POST | sources, enable/disable, run detail |
| `/api/admin/audit` | GET | the audit log |
| `/api/admin/stats` | GET | corpus and usage counts |

### `/api/admin/crawl`

One endpoint with an `action`, because these are five verbs on one object rather
than five resources.

```jsonc
POST /api/admin/crawl
{ "id": 1, "action": "start",    "mode": "changed-only" }
{ "id": 1, "action": "cancel"   }   // take it out of the queue
{ "id": 1, "action": "pause"    }
{ "id": 1, "action": "resume"   }
{ "id": 1, "action": "stop"     }
{ "id": 1, "action": "schedule", "intervalMinutes": 1440, "mode": "changed-only" }
```

`GET` returns live state: the running run's counters, heartbeat age, queue depth,
schedule and recent runs.

Notes:

- **`mode` defaults to `changed-only`** — the mode that costs the crawled site the
  least. An admin who wants a full pass says so.
- **`start` does not start anything.** It writes a request; the `crawler-tick`
  CronJob claims it within five minutes. Only one pending request per source.
- **`schedule` has a 15-minute floor**, so nobody can configure a crawl loop that
  hammers `wiki.gsi.de`.
- **`stop` writes a timestamp**, and the crawler ignores stops older than its own
  start — otherwise a stop pressed against nothing running would kill an unrelated
  run an hour later.

Every action writes to `audit_log`.

## Management (`llmbot-privileged`)

| Route | Method | |
|---|---|---|
| `/api/management/groups` | GET | only the groups the caller manages |
| `/api/management/groups/[id]/members` | GET, PUT | per-member grants |

`PUT` is rejected for any knowledge base outside the group's ceiling, whatever the
client sends. The UI hiding those checkboxes is a convenience, not the boundary.

## Conventions

- JSON in, JSON out, except `/api/chat` (SSE), `/metrics` (text) and the upload
  and PDF paths (binary / 302).
- Errors are SvelteKit `error()` with a real status: 400 malformed, 401 no session,
  403 wrong role, 404 not found or not yours, **413 quota or size**, 503 a backend
  is down.
- **A resource you may not see returns 404, not 403.** 403 would confirm it exists.
- Every mutating admin or management route writes to `audit_log`.
