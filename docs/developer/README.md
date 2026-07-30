# Developer documentation

## Read in order

1. **[Setup](setup.md)** — get it running, both ways (compose and k3s).
2. **[Architecture](architecture.md)** — what the pieces are and why.
3. **[Workflow](workflow.md)** — the loop you run all day.
4. **[Testing](testing.md)** — how to verify a change, including the things that
   fail silently.

## Reference

| Doc | Covers |
|---|---|
| [Database](database.md) | schema, migrations, and why migrations do not auto-apply |
| [API](api.md) | every HTTP route, including the SSE protocol |
| [Crawler](crawler.md) | connectors, modes, the control plane, extraction |
| [Documents agent](documents-agent.md) | Indico, the publication repository, linked PDFs — runs every turn |
| [Observability](observability.md) | the metrics registry, collectors, dashboards, logs |
| [Status page](status-page.md) | Uptime Kuma + the AI incident agent |
| [Runbook](runbook.md) | triage order and known failure modes |

## Before you touch anything

Read **`AGENTS.md`** in the repo root. It documents the specific traps in this
environment — several things that look like misconfiguration are deliberate, and
that file says which. It is also the more current source for operational detail.

Non-negotiables that will bite you:

- **`/metrics` is the only scrape target.** Do not add exporters. See
  [Observability](observability.md).
- **`db.ts` wraps queries in a proxy that hooks `then` and nothing else.** It
  looks over-engineered. Simplifying it executes SQL fragments that must never run
  on their own. See [Testing](testing.md#the-database-timing-proxy).
- **OIDC issuer strings must be byte-identical** between browser and pod.
  AGENTS.md §5.
- **Postgres migrations do not auto-apply** to an existing database.
  [Database](database.md).
- **Never run workloads on the Fedora box.** It is a client — no `npm run build`,
  no `npm install` beyond changing a dependency, no test runs. The Containerfile
  builds the app; verify against the cluster with `kubectl exec` and `curl
  http://chat.lab`. The dev box has ~2 GB free RAM and a local build knocks it
  over.

## Layout

```
frontend/          SvelteKit 2 + Svelte 5, adapter-node, TypeScript
  src/lib/server/  everything that must not reach the browser
    metrics/       the single registry + scrape-time collectors
    orchestrator/  gsi-fast, gsi-deep, and the image and documents agents
    sources/       indico.gsi.de, repository.gsi.de, external PDFs
  src/routes/      pages and API routes; /metrics lives here
crawler/           Python 3.12, no framework
  app/connectors/  one per source type
statuspage/        Python, stdlib HTTP server, no framework
db/migrations/     numbered SQL, applied in order
deploy/            config for Prometheus, Grafana, Loki, Promtail, Keycloak, S3
k8s/               manifests + Makefile.k8s (the real deployment)
compose.yaml       the whole stack on one machine
```
