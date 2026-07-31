# Flux CD delivery

GitOps delivery of the chat-gsi chart, managed by the **Flux Operator** (not
`flux bootstrap`). Flux pulls the chart as an OCI artifact and runs it as a
HelmRelease — no Git remote required.

```
OCI registry (chart)  ──►  OCIRepository  ──►  HelmRelease  ──►  chat-gsi-flux ns
  192.168.50.112:5000        (source-ctrl)      (helm-ctrl)        (the app)
```

## Files

| File | What |
|---|---|
| `flux-instance.yaml` | `FluxInstance` — the operator installs source/helm/notification controllers from it. No `spec.sync`: gitless, controllers only. |
| `chat-gsi/namespace.yaml` | the target namespace, `chat-gsi-flux` |
| `chat-gsi/ocirepository.yaml` | the chart source (local registry, `insecure: true`) |
| `chat-gsi/helmrelease.yaml` | the release: non-secret values inline, secrets via a Secret |

Secrets are **not** in Git: `chat-gsi-flux-secrets` (key `values.yaml`, holding the
chart's `secrets:` block) is created out of band and referenced via
`valuesFrom`, exactly as `.env` stays gitignored.

## Install (done once)

```bash
# 1. Flux Operator
helm install flux-operator oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator \
  -n flux-system --create-namespace --wait

# 2. Controllers
kubectl apply -f flux/flux-instance.yaml

# 3. The app source + release
kubectl apply -f flux/chat-gsi/namespace.yaml
kubectl create secret generic chat-gsi-flux-secrets -n chat-gsi-flux \
  --from-file=values.yaml=my-secrets.yaml     # a file with a top-level `secrets:` block
kubectl apply -f flux/chat-gsi/ocirepository.yaml -f flux/chat-gsi/helmrelease.yaml
```

## The deploy loop

Change the chart or its version, push, and Flux rolls it out:

```bash
helm push <(helm package ./chart -d - ) oci://192.168.50.112:5000/charts --plain-http
# bump ref.tag in ocirepository.yaml if the version changed, then:
kubectl apply -f flux/chat-gsi/ocirepository.yaml
flux -n chat-gsi-flux reconcile helmrelease chat-gsi --with-source
```

Watch it:

```bash
kubectl get ocirepository,helmrelease -n chat-gsi-flux
kubectl -n chat-gsi-flux get pods -w
```

> The 2.4.0 `flux` CLI queries an older source API than the 2.x distribution
> serves, so `flux get sources oci` errors. It is cosmetic — use
> `kubectl get ocirepository -A`, or upgrade the CLI to match.

## Delivering from ttl.sh instead

`helm_push.py` pushes the chart to ttl.sh with a 6h TTL. To have Flux pull from
there, edit `chat-gsi/ocirepository.yaml`:

```yaml
spec:
  url: oci://ttl.sh/chat-gsi-de/chat-gsi
  ref: { tag: "6h" }
  # drop `insecure` — ttl.sh is HTTPS
```

ttl.sh is public and ephemeral (the artifact self-destructs), so it suits demos,
not durable delivery. The local registry is the durable lab source.

## What this deploys

The HelmRelease runs **core only** (`observability`/`logs`/`crawler`/`statusPage`
off) into `chat-gsi-flux`, on distinct `-f.lab` hosts, so it never collides with
the live `chat-gsi` stack. Flip the toggles in `helmrelease.yaml` to have Flux
manage the full stack.
