# chat-gsi Helm chart

The whole GSI Assistant stack as one chart: the SvelteKit app, Keycloak SSO,
Postgres (pgvector), Valkey, SeaweedFS object storage, the crawler, the
Prometheus/Grafana/Loki/Promtail observability stack, and the independent AI
status page — with feature toggles for the heavy optional pieces.

It is hand-authored from the `k8s/` manifests, so every deliberate decision in
them (Recreate strategies for ReadWriteOnce volumes, the read-only status-page
RBAC, the SeaweedFS callback addressing, the "frontend is the only scrape
target" model) is preserved. `values.yaml` carries portable defaults;
`values-lab.yaml` reproduces the GSI lab exactly.

---

## Quick start (a real cluster)

Minimal setup is five things: **hosts, images, secrets, the LLM endpoint,** then
install.

```bash
# 1. Build and push the three app images to a registry your cluster can pull
#    (see "Building images" below), note the tag.

# 2. Put your real settings in an untracked overrides file:
cat > my-values.yaml <<'EOF'
hosts:
  chat: chat.mycorp.example
  keycloak: id.mycorp.example
  s3: s3.mycorp.example
  grafana: grafana.mycorp.example
  prometheus: prom.mycorp.example
  uptime: uptime.mycorp.example
  status: status.mycorp.example
image:
  frontend:   { repository: registry.mycorp.example/chat-gsi-frontend,   tag: "1.0.0" }
  crawler:    { repository: registry.mycorp.example/chat-gsi-crawler,    tag: "1.0.0" }
  statuspage: { repository: registry.mycorp.example/chat-gsi-statuspage, tag: "1.0.0" }
config:
  LLM_BASE_URL: https://llm.mycorp.example/api/v1
secrets:
  postgresPassword: "$(openssl rand -hex 24)"
  sessionSecret: "$(openssl rand -hex 32)"
  oidcClientSecret: "$(openssl rand -hex 24)"
  keycloakAdminClientSecret: "$(openssl rand -hex 24)"
  grafanaOidcClientSecret: "$(openssl rand -hex 24)"
  s3SecretKey: "$(openssl rand -hex 24)"
  keycloakAdminPassword: "$(openssl rand -hex 16)"
  grafanaAdminPassword: "$(openssl rand -hex 16)"
  kumaAdminPassword: "$(openssl rand -hex 16)"
  llmApiKey: "your-llm-proxy-key"
EOF

# 3. Install.
helm upgrade --install chat ./chart -n chat-gsi --create-namespace -f my-values.yaml
```

Point the seven `hosts` DNS records at your ingress controller and you are done.
Every OIDC issuer URL, redirect URI, Grafana OAuth endpoint and public download
link is **derived** from `hosts` + `tls.enabled`, so there is nothing else to
keep in sync.

### The one hard requirement: pods and browsers must agree on the issuer

Keycloak's issuer string has to be byte-identical whether it is read from a
browser or from inside a pod, or OIDC validation fails. On a normal cluster real
DNS gives you that for free. If your pods cannot resolve the public hostnames,
enable `nodeHostAliases` (see `values-lab.yaml`).

---

## Building images

### In CI (GitHub Actions → ghcr.io)

`.github/workflows/publish.yml` builds all three images and packages the chart,
pushing everything to `ghcr.io/<owner>` on every push to `main` (tag `:dev`) and
on a `v*` tag (semver). No PAT needed — the built-in `GITHUB_TOKEN` writes
packages. After the first run, point the chart at them:

```yaml
image:
  frontend:   { repository: ghcr.io/<owner>/chat-gsi-frontend }
  crawler:    { repository: ghcr.io/<owner>/chat-gsi-crawler }
  statuspage: { repository: ghcr.io/<owner>/chat-gsi-statuspage }
```

> **ghcr packages are private by default.** For the cluster to pull the images
> and Flux to pull the chart, either make the four packages public (repo →
> Packages → each package → Package settings → Change visibility), or provide
> credentials: `imagePullSecrets` for the images, and an OCIRepository
> `secretRef` (a docker-registry secret with a read:packages PAT) for the chart.

### By hand

```bash
for c in frontend crawler statuspage; do
  podman build -t registry.mycorp.example/chat-gsi-$c:1.0.0 -f $c/Containerfile ./$c
  podman push registry.mycorp.example/chat-gsi-$c:1.0.0
done
```

Then set `image.<component>.repository` and `.tag`. If the registry needs
credentials, create a pull secret and list it under `imagePullSecrets`.

---

## Feature toggles

The core (db, valkey, keycloak, frontend, seaweedfs) always installs. Turn any
of the heavy pieces off:

| Value | Default | Off means |
|---|---|---|
| `observability.enabled` | true | no Prometheus/Grafana (and no metrics dashboards) |
| `logs.enabled` | true | no Loki/Promtail (Promtail needs a cluster ClusterRole) |
| `crawler.enabled` | true | no scheduled crawl; the corpus is not built |
| `statusPage.enabled` | true | no Uptime Kuma / status page |

```bash
helm upgrade --install chat ./chart -n chat-gsi -f my-values.yaml \
  --set logs.enabled=false --set statusPage.enabled=false
```

---

## Using an external Keycloak (and role aliasing)

By default the chart runs its own Keycloak and imports a realm with the roles
the app expects (`llmbot-user`, `llmbot-privileged`, `llmbot-admin`). To use an
identity provider you already run instead, turn the bundled one off and point at
your realm — then **alias your existing role names** to the app's canonical
ones, so nobody has to create `llmbot-*` roles in your directory.

```yaml
keycloak:
  enabled: false                      # do not deploy Keycloak

oidc:
  issuer: https://id.mycorp.example/realms/staff   # your realm's issuer
  realm: staff
  clientId: chat-gsi-de               # a confidential client in that realm
  rolesClaim: realm_access.roles      # where roles sit in the token

  # Your realm keeps its own names; these say which count as the app's roles.
  roleAliases:
    llmbot-admin: gsi-admin           # a token with gsi-admin ⇒ app admin
    llmbot-privileged: [department-lead, manager]
    llmbot-user: [employee, staff]

grafana:
  oauthClientId: gsi-grafana          # a Grafana client in your realm
  roleAttributePath: "contains(roles[*], 'gsi-admin') && 'Admin'"

secrets:
  oidcClientSecret: "<the app client secret>"
  grafanaOidcClientSecret: "<the grafana client secret>"
```

**How aliasing works.** The app normalizes roles at the token boundary
(`oidc.ts`): for each alias, if the token carries the external name, the
canonical `llmbot-*` role is added alongside it. Every downstream check
(`permissions.ts`, the route guard, Grafana's role path) then works unchanged,
and the original names are kept for the admin UI. No app rebuild, no directory
changes.

**What your realm must provide**

- A confidential client for the app (`oidc.clientId`) whose secret you put in
  `secrets.oidcClientSecret`, with redirect URI `<chat host>/auth/callback`.
- A confidential client for Grafana (`grafana.oauthClientId`) if you keep
  observability on, with redirect `<grafana host>/login/generic_oauth` and a
  `roles` claim in its tokens.
- The roles claim reachable at `oidc.rolesClaim`. Keycloak realm roles are at
  `realm_access.roles` out of the box.
- The issuer must resolve to the SAME URL from browsers and from pods.

`oidc.adminBaseUrl` and `oidc.managementUrl` are optional overrides for the admin
user-picker and the Keycloak metrics collector; the base URL defaults to the
issuer with its `/realms/<realm>` suffix stripped.

## TLS

```yaml
tls:
  enabled: true
ingress:
  className: nginx
  tlsSecrets:               # per-host secret; keys are the host names above
    chat: chat-tls
    keycloak: id-tls
```

`tls.enabled: true` switches every derived URL to `https://` and adds a `tls:`
block to each Ingress. With cert-manager, set the issuer annotation under
`ingress.annotations` and leave `tlsSecrets` empty to let the shim create them.

---

## Reproducing the GSI lab

```bash
helm upgrade --install chat ./chart -n chat-gsi --create-namespace \
  -f chart/values-lab.yaml -f my-lab-secrets.yaml
```

`values-lab.yaml` sets local-path storage, the `.lab` hostnames, the node-IP
`nodeHostAliases`, the private `192.168.50.112:5000` registry with mutable `:dev`
tags, and the seeded demo users. Keep the real secrets in a second untracked
`-f` file, exactly as `.env` is gitignored today.

---

## Operating it

```bash
kubectl -n chat-gsi get pods -w                                   # watch rollout
kubectl -n chat-gsi create job --from=cronjob/crawler-tick crawl-now   # crawl now
helm -n chat-gsi upgrade chat ./chart -f my-values.yaml          # apply a change
helm -n chat-gsi uninstall chat                                  # remove (PVCs stay)
```

Migrations run automatically from the `db-migrations` ConfigMap on an **empty**
data volume only (Postgres `docker-entrypoint-initdb.d` semantics). A migration
added to an existing database must still be applied by hand — same as the raw
manifests.

---

## Design notes & known limitations

- **Service names are bare, not release-prefixed.** The internal wiring
  (`frontend:3000` as Prometheus' only target, the Grafana datasources, the
  SeaweedFS callbacks, `db:5432`) is keyed on these exact names and shipped in
  config files verbatim. The chart owns its namespace, so one install per
  namespace is the supported model — that is the price of not templating every
  one of those files, and it is the right trade here.
- **The realm is imported once.** Keycloak imports `realm-gsi.json` on first
  start of an empty data volume. Changing `oidc.*`, `hosts`, or the client
  secrets after that requires re-importing the realm (or editing it in the admin
  console) — Keycloak will not re-import over an existing realm.
- **Default status-page monitors are baked into the app image.** `provision.py`
  seeds monitors pointing at the `.lab` hostnames. On another domain, edit them
  in Uptime Kuma after first start, or leave `secrets.kumaAdminPassword` /
  `config.KUMA_ADMIN_USER` unset to skip auto-provisioning and add them by hand.
- **`config.*` values that embed a host are ignored** — the app gets its issuer,
  origin and public S3 endpoint from the derived values, not from `config`. Set
  hosts under `hosts:`, not by hand in `config:`.
- **Promtail assumes k3s' containerd log path** (`promtail.containerdPath`). On
  a non-k3s cluster set it to your runtime's path, or disable `logs`.
