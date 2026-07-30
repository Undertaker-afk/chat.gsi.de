# Risk and access control

## Who can see what

Three roles, assigned in Keycloak.

| Role | Can |
|---|---|
| `llmbot-user` | ask questions, within their grants |
| `llmbot-privileged` | + decide how much of a group's allowance each member gets |
| `llmbot-admin` | + create groups, set allowances, manage sources and crawls, read the audit log, open Grafana |

The two upper roles include `llmbot-user`, so nobody can hold an administrative
role without being able to use the thing they administer.

## The two-level model

An administrator sets a **ceiling** for a department: the most that department may
ever reach. The department's own manager decides how much of that ceiling each
person actually gets.

```
what a person can search  =  the baseline everyone gets
                          +  for each group they are in:
                               the manager's subset of that group's ceiling
```

**A manager can only ever narrow, never widen.** The ceiling is enforced on the
server for every write, not merely hidden in the interface — a request to grant
something outside it is rejected regardless of what the client sends.

This was verified by value, not by inspection: a manager attempting to grant
outside their ceiling was refused, and a question about a forbidden area retrieved
**nothing** from it — checked against the database records, not against the
wording of the answer.

## Four properties that matter

**Restricted wiki content is unreachable by construction.** Restricted areas are
hidden from anonymous visitors, and the crawler is deliberately never given
credentials. It is not excluded by a list somebody maintains — it is excluded
because the crawler cannot see it. A maintained exclusion list fails the first time
someone forgets to update it; this cannot.

**Permissions are applied before ranking, not after.** A document you may not see
never enters the process at all, so it cannot influence the answer or surface
through a citation. Post-filtering — the easier design — leaks through summaries
and citation lists.

**Credentials never reach the browser.** Sign-in is Authorization Code with PKCE,
entirely server-side. The browser holds an opaque session identifier and nothing
that works anywhere else. The LLM proxy key never leaves the server.

**Everything administrative is logged.** Every grant, revocation, membership
change, manager change and crawl trigger records who did it, to whom, and when.

## Revocation

Losing access to an area hides every conversation that cited it — filtered from the
sidebar, unreachable by URL — and purges it after **30 days**.

The delay is deliberate. A revocation made in error is fully repairable for a
month; after that the content is genuinely gone. Verified: revoking hid five
conversations and re-granting restored all five.

## Risks, and what is done about them

| Risk | Position today |
|---|---|
| **No TLS** | Deliberate for an isolated lab subnet. A blocker for anything else. |
| **Secrets in the repository** | Development credentials are checked in, matching the lab-open posture. All must be rotated and externalised before this leaves the lab. |
| **Keycloak state is not persistent** | Accounts created in its console die with the pod. Fine while the realm file is being edited; must change before real accounts exist. |
| **The metrics endpoint names users** | Storage-per-user metrics include usernames. Access is currently unauthenticated because the subnet is closed; a token exists and must be enabled before any external exposure. |
| **Single point of failure** | One node, one disk, no failover. A closed laptop lid takes everything down. |
| **Backups cover the database only** | Files in object storage are not in the dump. A restore would leave records pointing at missing files. |
| **The LLM proxy is a praktikum service** | It could rate-limit or disappear. All model access sits behind one module; switching endpoints is a configuration change. |
| **No automated tests** | The most substantial engineering gap. See [Delivery status](delivery-status.md#1-no-automated-test-suite). |
| **Storage accounting drifts** | Orphaned files accumulate from half-failed deletes — a deliberate direction (an invisible orphan beats a file a user cannot remove). Monitored on a dashboard; the reclamation sweep is not yet written. |
| **Managers are trusted inside their ceiling** | They cannot widen it, cannot touch other groups, and every action is logged. |
| **Retrieval slows as the corpus grows** | Search is currently exact rather than approximate — perfect recall, and fast at this scale. The approximate index is written and ready; measure at roughly 50,000 passages. |

## The one incident so far

On 28 July 2026 a crawl run hit a network error, discovered zero pages, and
concluded the entire corpus had been deleted — soft-deleting all 145 documents.

Nothing was permanently lost: the source text is retained in the database, so the
corpus was rebuilt locally without re-crawling anything.

Two permanent guards came out of it, and both have since been re-verified under
real conditions:

1. **An empty discovery is a failure, not an empty wiki.** A run that found nothing
   never deletes anything and is marked failed.
2. **A stopped run never deletes either** — it only saw part of the source, so
   everything after the stop would look deleted. Verified: stopping a crawl at 202
   of roughly 460 pages deleted nothing.

Worth recording at this level because it is the failure mode most likely to recur
in a system like this, and because the recovery path — the corpus is rebuildable
from the database alone, without touching the wiki — is a property worth keeping.

## What would need to change for wider use

In order:

1. TLS end to end.
2. Rotate every secret and move it out of the repository.
3. Persistent Keycloak storage.
4. Backups that include object storage.
5. Authentication on the metrics endpoint.
6. Automated tests for the permission filter, the delete sweep and quota
   arithmetic — the three places where a silent bug is most expensive.

Items 1–5 are configuration and deployment work. Item 6 is the only one that is
engineering.
