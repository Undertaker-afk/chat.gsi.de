# Setup

Two deployments exist and both are real:

- **compose** — the whole stack on one machine. Use it to develop.
- **k3s** — the lab deployment on `192.168.50.119`. This is what actually runs.

They share `.env`, the migrations, the realm file and the observability config.
They differ in hostnames and in how images get there.

---

## Prerequisites

| | Version | Notes |
|---|---|---|
| podman + podman-compose | 5.x | or Docker; `COMPOSE` is a variable in the Makefile |
| Node | 22+ | only for running the frontend natively |
| Python | 3.12+ | only for running the crawler natively |
| kubectl | any recent | k3s path only |
| An LLM proxy | — | GSI's, at `192.168.50.1:8080/api/v1` |

You need reachability to the LLM proxy. Nothing else is optional — there is no
mock model.

---

## Path A: compose

```bash
cp .env.example .env
```

Edit `.env`. The values you **must** change:

| Key | Why |
|---|---|
| `POSTGRES_PASSWORD` | |
| `SESSION_SECRET` | 32 random bytes |
| `OIDC_CLIENT_SECRET` | must equal the `secret` on the `chat-gsi-de` client in `deploy/keycloak/realm-gsi.json` |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | same, for `chat-gsi-de-admin` |
| `GRAFANA_OIDC_CLIENT_SECRET` | same, for `grafana` |
| `S3_SECRET_KEY` | must match `deploy/seaweedfs/s3.json` |
| `LLM_API_KEY` | the proxy key |

> A client-secret mismatch does not fail at the login page. It fails at token
> exchange, *after* login appears to be working. If sign-in redirects back and
> then errors, check these first.

Then:

```bash
make up          # build and start everything
make check       # verify the LLM proxy, embedding dimensions and the database
make login-info  # prints the URLs and the dev accounts
```

### What you get

| URL | Service |
|---|---|
| http://localhost:3000 | the application |
| http://keycloak.localhost:8081 | Keycloak, realm `gsi` |
| http://localhost:3001 | Grafana |
| http://localhost:9090 | Prometheus |
| http://localhost:3002 | Uptime Kuma |
| http://localhost:3003 | the status page |
| http://localhost:3000/metrics | the raw exposition |
| http://localhost:8333 | SeaweedFS S3 gateway |

All are bound to `127.0.0.1`, so nothing is exposed off the machine. Keycloak is
on 8081 because 8080 is taken by the Znuny test instance; Uptime Kuma is on 3002
because 3001 is Grafana's.

`keycloak.localhost` is not an `/etc/hosts` edit — the host resolves `*.localhost`
to 127.0.0.1, and a compose network alias makes the same name resolve inside the
network. That is what makes the OIDC issuer string identical from both sides.

### Dev accounts

Imported from `realm-gsi.json` on every Keycloak start:

| User | Password | Roles |
|---|---|---|
| `testuser` | `testuser` | `llmbot-user`, `llmbot-admin` |
| `manager` | `manager` | `llmbot-user`, `llmbot-privileged` |
| `normaluser` | `normaluser` | `llmbot-user` |

Use all three. Most access-control bugs are invisible as an admin.

### Fill the corpus

Nothing is indexed on a fresh database.

```bash
make crawl                  # incremental crawl of all enabled sources
make status                 # recent runs
```

A full wiki crawl takes hours — `wiki.gsi.de` enforces a 5-second crawl delay and
the connector respects it regardless of what `.env` says. For development, crawl
one small source:

```bash
podman compose run --rm crawler crawl --source virgo-docs --mode incremental
```

Roughly 41 pages. Budget ~20 minutes for the first run — a changed page costs
about 28 seconds, most of it LLM extraction. Enough to make retrieval work, and it
populates the validators that make subsequent `changed-only` runs take seconds.

---

## Path B: k3s (the lab)

Read AGENTS.md §1–§4 first. The short version: the repo and the image registry
live on the Fedora box (`192.168.50.112`), every workload runs on the Ubuntu node
(`192.168.50.119`), and images move between them through a plain-HTTP registry.

```bash
make -f k8s/Makefile.k8s up      # config + build + push + deploy
make -f k8s/Makefile.k8s status  # pods, services, ingresses, PVCs
```

`up` is `config` (secret + ten configmaps), `build`, `push`, `deploy`. It is safe
to repeat.

### Hostnames

Seven `.lab` names in `/etc/hosts` on the Fedora box, all pointing at
`192.168.50.119`:

```
192.168.50.119 chat.lab keycloak.lab s3.lab grafana.lab prometheus.lab uptime.lab status.lab
```

**These are load-bearing, not cosmetic.** OIDC requires the browser and the pod to
resolve the issuer to the *identical URL string*. The browser gets there through
`/etc/hosts`; the pods get there through a `hostAliases` block in the manifests.
Changing `OIDC_ISSUER` to an in-cluster name resolves fine and breaks login,
because the discovery document still advertises `keycloak.lab`.

Verify after touching anything in this area:

```bash
curl -s http://keycloak.lab/realms/gsi/.well-known/openid-configuration | head -c 120
kubectl -n chat-gsi exec deployment/frontend -- node -e \
  "fetch('http://keycloak.lab/realms/gsi/.well-known/openid-configuration').then(r=>r.json()).then(j=>console.log(j.issuer))"
```

Both must print `http://keycloak.lab/realms/gsi`.

### `.env` values that k8s ignores

`OIDC_ISSUER`, `OIDC_REDIRECT_URI`, `APP_ORIGIN`, `S3_PUBLIC_ENDPOINT` and
`KEYCLOAK_BASE_URL` are overridden by explicit `env:` entries in
`k8s/40-frontend.yaml`. Editing `.env` for these has **no effect** — edit the
manifest.

### `.env` parsing

The secret is built with `--from-env-file`, which does not strip quotes.
`KEY="value"` puts the quote characters into the secret.

---

## Running the frontend natively

Fastest inner loop. Port-forward the backing services and run Vite locally:

```bash
make -f k8s/Makefile.k8s dev-forward   # db, valkey, s3, prometheus → localhost
cd frontend && npm install && npm run dev
```

Keycloak needs no forward — `keycloak.lab` already resolves from the Fedora box.

Without Keycloak at all (low-memory machines only):

```bash
make dev-noauth
```

This bypasses authentication entirely. It exists for UI work and must never be
set anywhere real.

---

## Verifying the install

```bash
make check                                     # LLM proxy + embedding dims + db
curl -s localhost:3000/health                  # {"status":"ok"}
make metrics | head -40                        # the exposition
```

Then sign in as all three dev users and confirm the account menu differs. See
[Testing](testing.md) for the full pass.
