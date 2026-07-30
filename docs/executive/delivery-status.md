# Delivery status

As of **29 July 2026**. Deployed on the lab cluster and working end to end.

## Complete and verified

"Verified" here means measured against the running system, not reviewed as code.

| Area | Status | Evidence |
|---|---|---|
| Chat, fast and deep modes | ✅ | 0.27 s to first token; deep mode 2 rounds / 5 sub-agents in 5.4 s |
| Citations | ✅ | deep-link to the source page and anchor; shared pool deduplicates |
| Retrieval | ✅ | correct passage at rank 1 on spot checks, with clear margin |
| Authentication (Keycloak, PKCE) | ✅ | full flow as three separate accounts; tokens never reach the browser |
| Role gates | ✅ | `normaluser` refused both admin areas; `manager` refused `/admin`, allowed `/management` |
| Knowledge-base access control | ✅ | a forbidden base contributed **no chunks** — checked against the database, not the answer text |
| Revocation and grace period | ✅ | revoking hid 5 conversations; re-granting restored all 5 |
| Audit log | ✅ | every step of the above recorded |
| Message branching | ✅ | edit → `[2/2]`, switch back → original answer unchanged |
| Uploads on object storage | ✅ | byte-identical round trip; tampered signature → 403; delete removed row *and* object |
| Quota | ✅ | uploads and chats reported separately against one 1 GiB budget |
| Generated files | ✅ | survive their conversation being deleted |
| Crawler, all four modes | ✅ | changed-only measured at 205 s → 5 s on virgo-docs |
| Crawler control (start/pause/stop/schedule) | ✅ | pause held 60 s with a live heartbeat; stop ended the run and deleted **nothing** |
| Metrics, one endpoint | ✅ | 9 collectors, all reporting |
| Dashboards | ✅ | **318 queries verified: 299 returning data, 0 invalid** |
| Logs (Loki) | ✅ | 13 log queries verified across two languages' output |
| Grafana access control | ✅ | real login flow: `testuser` → Admin; `manager` and `normaluser` → refused |
| Status page + AI incident agent | ✅ | full lifecycle: outage detected → incident published citing the real error → recovery → AI resolution and all-clear |

## Scale today

| | |
|---|---|
| Sources | 3 (`wiki`, `virgo-docs`, `www`) |
| Public wiki webs discovered | 28 |
| Knowledge bases | one per web plus one per non-wiki source |
| Dashboards / panels | 10 / 262 |
| Database migrations | 19 |
| Metrics families | ~80 |

## Known gaps

Listed in the order they matter.

### 1. No automated test suite

There is no CI, no unit tests, no integration tests. Verification has been manual
and thorough — the numbers above are real — but it is not repeatable by someone
else, and it does not run on every change.

**Consequence.** The failure modes in this system are overwhelmingly *silent*: a
broken permission filter still returns results, a broken dashboard query renders
"No data" identically to a metric nobody has used, a crawler mode that skips
nothing still reports success. Manual verification catches these exactly once.

**Mitigation today.** `docs/developer/testing.md` documents every check and every
silent failure mode found so far, including the specific values to expect. That is
a checklist, not a test suite.

**Cost to close.** The highest-value subset — the access-control filter, the
crawler's delete sweep, the quota arithmetic — is a few days of work and would
cover the three places where a silent bug is most expensive.

### 2. No TLS

The lab subnet is isolated and deliberately open. Nothing is encrypted in transit.
This is a documented decision for the lab, and a hard blocker for anything else.

### 3. State that does not survive

- **Keycloak runs without persistent storage.** Users created in its admin console
  die with the pod; the realm re-imports from a file on every restart. Intentional
  while the realm file is being edited, and it must change before real accounts
  exist.
- **Backups cover the database only.** Uploads and generated files live in object
  storage and are not in the dump. A restore from backup alone yields records
  pointing at files that no longer exist.

### 4. Single node, no redundancy

Everything runs on one laptop-class machine. A suspended lid takes the whole system
down. Storage is local-path on one disk. There is no failover for anything.

### 5. Secrets are in the repository

Development client secrets and passwords are checked in, matching the lab-open
posture. Every one must be rotated and moved out before this leaves the lab.

### 6. Storage accounting drifts

Object storage holds slightly more than the database believes it does — orphaned
objects from half-failed deletes. This is a deliberate design direction (an
invisible orphan beats a broken image a user cannot remove), the gap is monitored
on a dashboard, and a reclamation sweep is not yet written. It is not zero today.

## What this is not blocked on

Worth saying explicitly, because these often are blockers and here they are not:

- **Access control is finished**, including delegation to department managers with
  a server-enforced ceiling, and it has been verified by value rather than by
  inspection.
- **Observability is finished** and unusually complete — including the discipline
  of verifying every dashboard query, which found two alert rules that could never
  have fired.
- **The crawler will not damage the corpus.** The one incident that did (a network
  error caused an empty discovery, which soft-deleted all 145 documents) produced
  two permanent guards, and both have since been re-verified under real
  conditions.
