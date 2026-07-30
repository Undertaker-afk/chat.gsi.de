# Production readiness

## Where it stands

The system is **functionally complete and operationally immature**. Every feature
works and has been verified against the running system; what is missing is the
hardening, redundancy and automation that separate a working prototype from a
service people depend on.

That is a good position to be in. The remaining work is mostly known, mostly
configuration, and does not require redesigning anything.

## What it runs on today

| | Today | What real use needs |
|---|---|---|
| Compute | one laptop-class node | a server, or two for failover |
| Storage | one local disk | redundant storage; the file layer already supports replication |
| Network | isolated lab subnet, no TLS | TLS end to end |
| Identity | Keycloak without persistent storage | Keycloak with a database |
| Backups | database only, on demand | database **and** object storage, scheduled and tested |
| Availability | none — a closed lid stops everything | defined targets and the redundancy to meet them |

## The work, in order

### Before any real user

1. **TLS end to end.** Sign-in in particular must not run in the clear.
2. **Rotate every secret** and move them out of the repository into a secret store.
3. **Persistent Keycloak storage**, so accounts survive a restart.
4. **Backups that include object storage.** The current dump covers the database
   only; restoring from it alone gives records pointing at files that no longer
   exist. This is the item most likely to be discovered at the worst moment.
5. **Authentication on the metrics endpoint**, which currently names users.

None of these is difficult. All are configuration and deployment work, and each
one is individually a day or less.

### Before it is depended on

6. **Automated tests** for the three places where a silent bug is most expensive:
   the permission filter, the crawler's delete sweep, and quota arithmetic.
   Roughly a few days, and the only item on this list that is real engineering.
7. **Real hardware.** A server rather than a laptop; storage that survives a disk.
8. **Someone who is responsible for it.** Alerts already exist and fire — they
   need a destination and a person.

### When it grows

9. **Approximate search**, when the corpus reaches roughly 50,000 passages. The
   migration is written and ready; measurement showed the top results are
   unchanged by the compression it uses, so this is a switch-on rather than a
   project.
10. **Storage reclamation** for orphaned files. Monitored today, not yet swept.
11. **More storage capacity**, by adding file-server replicas. Already supported;
    the application does not notice.

## What is genuinely ready

Worth stating, because it is more than is usual at this stage:

**Access control.** Two-level delegation with a server-enforced ceiling, verified
by inspecting database records rather than reading answers. Restricted content is
unreachable by construction rather than by a maintained list.

**Observability.** Ten dashboards, 262 panels, over a single metrics endpoint, with
logs from every component in one searchable place. Every dashboard query was
verified rather than assumed — which found two alert rules that could never have
fired, and six panels that would have shown empty forever.

**Status reporting.** A public status page that shares nothing with the system it
reports on, so it works during exactly the outages it exists to describe. Its AI
writes prose and never facts: which component, when, for how long, and what the
error was are all computed in code. Every message has a deterministic fallback, and
the page labels which one a reader is looking at.

**The crawler.** Four modes including a change-detecting one that took a re-crawl
from 205 seconds to 5. Start, pause, stop and scheduling from the admin interface,
with two independent guards against deleting the corpus.

## Two honest observations

**The observability is ahead of the rest of the system.** That is not a criticism —
it means that when something does go wrong, it will be understood quickly, and the
verification discipline that produced it (query for the expected value, do not
trust that a thing loaded) is the same discipline the missing test suite needs.

**The gap between prototype and production here is unusually well-mapped.** Every
item above came from working on the system rather than from a checklist, most have
a documented reason, and several were found by something actually breaking. A list
of known problems is worth considerably more than an absence of known problems.
