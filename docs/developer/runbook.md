# Runbook

## Triage order

```bash
kubectl -n chat-gsi get pods                    # what is not Ready
kubectl -n chat-gsi describe pod <name>         # Events, read bottom-up
kubectl -n chat-gsi logs <name> --previous      # if it is restarting
kubectl -n chat-gsi logs <name> -c wait-for-deps  # frontend stuck in Init
```

Then, in Grafana: **Overview** first. `up` and `chatgsi_collector_up` sit next to
each other for exactly this moment.

## Symptom → cause

| Symptom | Cause |
|---|---|
| `ImagePullBackOff` on a `192.168.50.112:5000/…` image | the registry container stopped on the Fedora box, or the image was never pushed. `podman start registry` |
| Frontend stuck `Init:0/1` | a backing service is not Ready; the init container names which one in its logs |
| `Pending` PVC | node disk full, or a `ReadWriteOnce` PVC still bound to a terminating pod |
| Login redirect loop, or `invalid_redirect_uri` | hostname/issuer mismatch — AGENTS.md §5 |
| Token exchange fails after the login page works | client-secret mismatch between `realm-gsi.json` and `.env` |
| Keycloak `CrashLoopBackOff` right after a realm edit | a client `description` over 255 chars aborts the whole realm import |
| Node `NotReady`, everything unreachable | the laptop suspended or the lid closed |
| Pods cannot reach the LLM proxy | check `192.168.50.1:8080/api/v1` from the node itself first |
| **Every** Grafana panel empty at once | the frontend is down — it is the only scrape target |
| **One** dashboard section empty, rest fine | that collector cannot reach its backend; check `chatgsi_collector_up` |
| Grafana: "user does not have a role" | the account lacks `llmbot-admin`. That is the gate working |
| Panel shows "No data" where 0 is expected | a PromQL vector-match failure — the two sides carry different labels |
| Loki panel errors with `JSONParserErr` | a `\| json` without `\| __error__=""` |
| Loki/Promtail stuck in `ContainerCreating` | a ConfigMap was never created — `config` must use server-side apply |
| changed-only skips nothing | validators not populated yet (needs one full run), or the source sends none |
| Crawl stuck `running` forever | the pod died; the next `tick` reaps it after 15 minutes |
| Queued crawl never starts | the `crawler-tick` CronJob is not running |
| Status page says "Status Unknown" | no monitors in Uptime Kuma, or none has reported yet |
| Incidents read like templates | the LLM proxy is unreachable; note the absent `AI` badge |

## Common recoveries

### The frontend is down and so is every dashboard

Expected. One scrape target means one point of failure for the exposition. Fix the
frontend; the metrics come back with it. During the outage, `status.lab` is the
thing that still works — it shares nothing with the stack.

```bash
kubectl -n chat-gsi logs deployment/frontend --previous
kubectl -n chat-gsi rollout restart deployment/frontend
```

### Keycloak crash-loops after a realm edit

`CLIENT.DESCRIPTION` is `VARCHAR(255)` and a longer description aborts the whole
import. Shorten it, then:

```bash
make -f k8s/Makefile.k8s config
kubectl -n chat-gsi rollout restart deployment/keycloak
```

Keycloak is ephemeral (`start-dev`, no PVC), so the realm re-imports on every
restart and nothing is lost — but users created in the admin console are gone too.

### A crawl is stuck

```bash
kubectl -n chat-gsi get jobs
make -f k8s/Makefile.k8s tick     # reaps stale runs before doing anything else
```

A run left `running` by a killed pod blocks every future scheduled crawl of that
source. `tick` reaps it after the heartbeat has been stale for 15 minutes; running
`tick` by hand does it now.

### The corpus lost documents

Deletion is soft.

```bash
podman compose run --rm crawler reindex --undelete
```

Then work out **why**. The sweep only runs when a crawl saw more than zero pages
and was not stopped, so a mass deletion means discovery returned a partial result
that looked complete. Check `crawl_runs.pages_seen` for the run against its
predecessors.

### Grafana is locked out because Keycloak is broken

Set `GF_AUTH_DISABLE_LOGIN_FORM=false`, restart Grafana, log in as `admin` with
`GRAFANA_ADMIN_PASSWORD`. **Put it back afterwards** — it is a recovery path, not
a second way in.

### Storage is full

Check the right number. The Storage dashboard's headline gauge is usage against a
*configured* 25 TiB plan; the real filesystem is `chatgsi_seaweed_disk_bytes`, and
on k3s that is `/var/lib/rancher/k3s/storage` shared with every other PVC. **At 3%
of plan the real disk can still be full.**

If the accounting gap is large, there are orphaned objects — quota is enforced
against the database's number, so the disk fills faster than any user's quota says
it can.

```bash
kubectl -n chat-gsi scale statefulset/seaweed-volume --replicas=3   # add capacity
```

### Loki filled the disk

`retention_enabled` must be true in `deploy/loki/loki.yaml`. Without it the 31-day
retention setting is decoration and the compactor never enforces it.

## Never do these without being asked

- `sudo /usr/local/bin/k3s-uninstall.sh` — destroys the cluster and all data
- `make -f k8s/Makefile.k8s nuke` / `kubectl delete namespace chat-gsi` — same for
  the app
- change the node's IP, hostname or `--node-ip` — both are baked into the node
  object and the API server certificate; changing either means reinstalling k3s
- re-enable swap or unmask the sleep targets — a suspended node takes the whole
  cluster down, and it is a laptop
- enable ufw — without `sudo ufw allow from 192.168.50.0/24` it cuts off the API
  server, NodePorts and the registry pull path at once

## Reporting

State what was **verified** versus what was **assumed**. For anything touching
hostnames, secrets or metrics, run the verification commands and quote the output
rather than asserting it worked — those failure modes are silent until a user
tries to log in, or until an incident starts and the dashboard is empty.
