# Workflow

## The loop

All targets run from the repo root.

| You changed | Run |
|---|---|
| frontend or crawler code | `make -f k8s/Makefile.k8s restart` |
| `.env`, a migration, `realm-gsi.json`, `s3.json` | `config` then `restart` |
| anything in `k8s/` | `deploy` |
| Grafana dashboards, Prometheus config, Loki, Promtail | `config` then `restart-observability` |
| the status agent | `restart-status` |
| nothing, you just want to look | `logs`, `status`, `metrics` |

```bash
make -f k8s/Makefile.k8s restart          # build + push + rollout + wait
make -f k8s/Makefile.k8s logs             # follow the frontend
make -f k8s/Makefile.k8s metrics          # the exposition, without waiting for a scrape
make -f k8s/Makefile.k8s tick             # run one scheduler pass now
```

On compose it is `make up`, `make logs`, `make metrics`.

### Pushing is not deploying

Tags are mutable (`:dev`), so every Deployment sets `imagePullPolicy: Always`.
Pushing an image changes nothing until a `rollout restart`. `restart` does both.

### Why `restart-observability` exists

Prometheus re-reads its config only on SIGHUP and Grafana only at startup. Running
`config` alone updates the ConfigMaps and changes nothing either can see.

### Why `config` uses server-side apply

Client-side `kubectl apply` stores a full copy of the object in the
`last-applied-configuration` annotation, capped at 256 KB. The dashboard bundle is
larger. Because make stops at the first error, the client-side failure silently
skipped every ConfigMap after it — Loki and Promtail sat in `ContainerCreating`
for nine minutes with no useful error. `--server-side --force-conflicts` fixes it.

## Faster inner loop

```bash
make -f k8s/Makefile.k8s dev-forward   # db, valkey, s3, prometheus → localhost
cd frontend && npm run dev
```

Vite HMR against real cluster state. Keycloak needs no forward.

## Conventions

### Where code goes

- **`src/lib/server/`** — anything holding a secret, a database handle or a
  policy decision. SvelteKit refuses to bundle it into the client.
- **`src/lib/`** — shared with the browser. Assume it is public.
- **`src/routes/api/`** — one directory per resource. `+server.ts` exports `GET`,
  `POST`, `DELETE`.
- **`src/lib/components/ui/`** — shadcn-svelte, added with
  `npx shadcn-svelte@latest add <name>`. Do not hand-edit; regenerate.

### Style

- Colour comes from semantic tokens (`bg-background`, `text-muted-foreground`).
  No per-component `dark:` overrides — dark mode is a token swap.
- Svelte 5 runes (`$state`, `$derived`, `$props`, `$effect`). No stores in new
  code.
- German UI strings. Answers follow the user's language.
- Comments explain **why**, not what. The existing comments are load-bearing
  documentation of non-obvious decisions; match that density.

### Adding a metric

Declare it in `metrics/metrics.ts`, never inline at a call site. That file is the
cardinality budget — if a label is added, that is where it is justified. Anything
needing another service belongs in `metrics/collectors.ts`, with a timeout, behind
`cached()`. See [Observability](observability.md).

### Adding a migration

New numbered file in `db/migrations/`. It will **not** apply to an existing
database on its own:

```bash
make -f k8s/Makefile.k8s migrate FILE=db/migrations/020_thing.sql
```

See [Database](database.md).

### Adding a crawler connector

Subclass the connector base, implement discovery and fetch, register the source
row. See [Crawler](crawler.md#adding-a-connector).

## Checks before you push

```bash
cd frontend && npm run check     # svelte-check
cd frontend && npm run lint      # prettier + eslint
python -m compileall crawler/app statuspage/app
```

There is no automated test suite. What replaces it is in [Testing](testing.md) —
read it, because the failure modes here are mostly silent.

## Things that will cost you a debugging round

- **Keycloak's `CLIENT.DESCRIPTION` is `VARCHAR(255)`.** A longer `description` on
  any client in `realm-gsi.json` aborts the *entire* realm import and crash-loops
  the pod with an H2 "Value too long" error. Keep client descriptions short.
- **Keycloak is ephemeral.** It runs `start-dev` with no PVC, so users created in
  the admin console die with the pod and the realm file re-imports on every
  restart. Intentional while the realm file is being edited.
- **Client secrets in `realm-gsi.json` must match `.env`.** A mismatch fails at
  token exchange, well after login appears to work.
- **`ReadWriteOnce` PVCs need `strategy: Recreate`.** `RollingUpdate` deadlocks
  waiting for a volume the outgoing pod still holds.
- **`seaweed-volume` is a StatefulSet**, so each replica keeps a stable DNS name
  to register with the master. Scale with `kubectl scale statefulset/…`.
