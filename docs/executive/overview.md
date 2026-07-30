# Overview

## The problem

GSI's institutional knowledge is written down — in a Foswiki with 28 public webs,
in the virgo HPC user guide, on www.gsi.de — and is very hard to find. Search
returns page titles; the answer is three paragraphs into the fourth result, or
spread across pages nobody wrote together.

A general-purpose chatbot does not fix this. It has never read any of it, and it
will confidently invent GSI-specific answers, which is worse than no answer at
all.

## What was built

An assistant that reads GSI's own documentation and answers from it, with a
citation on every claim.

Three properties, in priority order:

1. **It can only answer from indexed documents.** No corpus content, no answer —
   it says so instead of guessing.
2. **It can only answer from documents you are allowed to see.** Enforced in the
   database query, not in the interface.
3. **Every claim is traceable.** Numbered citations link to the source page and
   section, so a reader can check.

Two modes: a fast one that answers in seconds, and a deep one that breaks a
complex question into parts, researches them in parallel, and synthesises — for
questions whose answer does not live on any single page.

## Measured behaviour

From verification against live systems:

| | |
|---|---|
| First token, fast mode | **0.27 s** |
| A complete cited answer, fast mode | **0.6 s** |
| Deep mode, 2 rounds / 5 sub-agents | **5.4 s** |
| Retrieval quality (spot check) | correct passage at rank 1, with clear separation from rank 2 |
| Crawl cost per changed page | ~28 s (5 s politeness delay + ~20 s extraction) |
| Crawl cost per unchanged page | **~0 s** where the source supports it |

That last row is a real efficiency result, not a projection: a virgo-docs re-crawl
went from **205 seconds to 5 seconds** by not downloading 40 of 41 unchanged
pages.

## Why it is built this way

Four decisions worth understanding at this level.

**Search is hybrid, not purely AI.** Meaning-based search alone reliably misses
exact identifiers — `sbatch`, `/lustre/rz`, an error message — which is a large
share of what people actually ask about. Classic keyword search runs alongside it
and the two are merged. This costs nothing extra and fixes a whole class of
failures.

**Permissions are applied before ranking, not after.** A document you may not see
never enters the process. Filtering afterwards is easier to build and leaks
through citations, summaries and the model's own knowledge of what it just read.

**The crawler cannot see restricted content — by construction.** Restricted wiki
areas are hidden from anonymous visitors, and the crawler is deliberately never
given credentials. It is not excluded by a list somebody has to maintain; it is
excluded because the crawler genuinely cannot reach it. That closes the largest
risk in the original plan by design rather than by discipline.

**One metrics endpoint, not a dozen agents.** Everything measurable is exposed
from a single place that queries the other components on demand. Fewer moving
parts, nothing to reconfigure when a component moves. The tradeoff is explicit and
documented: if the application is down, all monitoring goes dark together — which
is precisely why the status page shares nothing with it.

## What it costs to run

No licence fees. Everything is open source or already in use at GSI: PostgreSQL,
Keycloak, Grafana, Prometheus, Loki, SeaweedFS, Uptime Kuma.

The one external dependency is the **GSI LLM proxy**, already operated
independently. All model access sits behind a single module, so switching from the
praktikum proxy to a production endpoint is a configuration change.

Hardware today is one laptop-class node. See
[Production readiness](production-readiness.md).

## Scope boundary

This answers questions about **public-to-staff documentation**. It is not a
records system, not a document management system, and it does not index
restricted wiki spaces, personal files or email. Per-document access control
inside the wiki is explicitly out of scope — the model is per knowledge base, and
restricted spaces are simply not crawled.
