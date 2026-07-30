# chat.gsi.de — documentation

A retrieval-augmented assistant over GSI's internal documentation. It crawls the
Foswiki, the virgo HPC docs and www.gsi.de, indexes them as vectors, and answers
questions with citations back to the page it read.

These docs are split by who is reading them. Start in the right place.

| You are | Start here | What it covers |
|---|---|---|
| Using the assistant | [user/](user/) | Logging in, asking questions, files, quotas, what you are allowed to see |
| Running a department | [user/managing-your-group.md](user/managing-your-group.md) | Granting your team access to knowledge bases |
| Administering it | [user/administration.md](user/administration.md) | Groups, sources, crawls, the audit log |
| Building or operating it | [developer/](developer/) | Setup, architecture, testing, observability, the runbook |
| Deciding about it | [executive/](executive/) | What it does, what it cost, what the risks are |

## Scope of these docs

They describe the system **as deployed in the lab**: a single k3s node at
`192.168.50.119`, reached through `.lab` hostnames. A production deployment would
change hostnames, TLS and secrets but nothing about how the system works.

`AGENTS.md` in the repo root is a different document with a different job: it is
the operating manual for anyone (human or agent) working *on* the cluster, and it
records the specific traps this environment contains. Where the two disagree about
an operational detail, AGENTS.md is the newer and more specific source.

## The short version

```
wiki.gsi.de ─┐
virgo-docs  ─┼─▶ crawler ──▶ Postgres + pgvector ──▶ retrieval ──▶ LLM ──▶ answer
www.gsi.de  ─┘                     ▲                                       + citations
                                   │
     Keycloak (who you are) ───────┴─── knowledge-base grants (what you may search)
```

Everything a user uploads or the assistant generates lives in SeaweedFS behind an
S3 API. One `/metrics` endpoint on the frontend feeds Prometheus, Grafana and a
set of alerts. A separate, deliberately independent status page reports outages.
