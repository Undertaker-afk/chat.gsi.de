# Dashboards and status

Two different things, on purpose.

| | `http://status.lab` | `http://grafana.lab` |
|---|---|---|
| For | everyone | administrators only |
| Answers | "is it broken?" | "why, and how badly?" |
| Needs login | no | yes, `llmbot-admin` |
| Survives an outage | yes, by design | not necessarily |

---

## The status page

`http://status.lab` — modelled on githubstatus.com. A banner, one row per
component with 90 days of uptime bars, and an incident history.

It is built to work when nothing else does: it shares no database with the
application, has no dependency on it starting, and its own health check reports
only on itself. The one moment anyone opens a status page is the moment something
is broken.

### Reading the banner

| Banner | Means |
|---|---|
| **All Systems Operational** | every check ran and every check passed |
| **Mostly Operational** | some checks passed, some have never run — it names which |
| **Partial System Outage** | something is down |
| **Major System Outage** | something critical is down |
| **Status Unknown** | nothing has reported yet |

"Mostly Operational" and "Status Unknown" exist because *"we checked and it is
fine"* and *"we have not checked"* must not look the same. A green banner during
the window when nothing has been verified is the worst thing a status page can do.

### Incidents

Written automatically. An incident opens after two consecutive failing checks and
resolves after three consecutive healthy ones — resolving is deliberately stricter,
because declaring victory early and re-opening reads far worse than resolving late.

Correlated failures fold into **one** incident. When the database goes down the
chat interface fails moments later; that is one event to a reader, not two.

An **AI** badge marks text a language model wrote. What the model does is turn
`keycloak: connect ECONNREFUSED` into "signing in is unavailable" — **it writes
the prose and never the facts**. Which component, when it started, how long it
lasted, what the check reported: all computed in code. Without the badge you are
reading a deterministic summary, which usually means the model was unreachable —
the page keeps reporting either way.

### Uptime Kuma

`http://uptime.lab` is the checker behind the status page, and it has its own
admin login. Five checks are created automatically:

| Monitor | Checks |
|---|---|
| Chat interface | `http://chat.lab/health` |
| Sign-in (Keycloak) | Keycloak's OIDC discovery document |
| File storage | the SeaweedFS S3 gateway |
| Dashboards (Grafana) | Grafana's health endpoint |
| Monitoring (Prometheus) | Prometheus' health endpoint |

Add your own there and they appear on the status page automatically. **The name
you give a monitor is what the public sees**, including inside incident text —
name them for readers ("Sign-in"), not for infrastructure ("keycloak-svc:8080").

---

## Grafana

`http://grafana.lab`, login through Keycloak, **`llmbot-admin` only**. A user
without the role is refused at login rather than given a read-only view. There is
no local login form to fall back on.

Ten dashboards in the `chat.gsi.de` folder:

| Dashboard | Answers |
|---|---|
| **Overview** | is everything up; a node graph of data flowing between the main components |
| **Canvas** | the full system topology with live per-component status |
| **Storage** | S3 usage against the 25 TiB plan, real disk, per-user usage |
| **LLM & retrieval** | response times, time to first token, tokens, retrieval quality |
| **Crawler** | run outcomes, pages, skip rates, queue depth, schedules |
| **Vector database** | chunks, dimensions, tokens, index state |
| **Users & activity** | daily active users, conversations, feedback |
| **Files** | uploads vs. generated files, sizes, types |
| **Caches** | Valkey and the external-fetch cache |
| **Logs** | everything, searchable, from all components |

### Two panels to understand before an incident

**On Overview:** `up` and `chatgsi_collector_up` sit next to each other. "The
application is down" and "one backend is down" must never look alike — the first
empties every dashboard at once, the second empties one section.

**On Storage:** the headline gauge is usage against a *configured* 25 TiB plan,
not measured hardware. The real filesystem under the volume servers is reported
separately. **At 3% of plan the real disk can still be full.** The "accounting
gap" panel shows the difference between what the database thinks is stored and
what object storage actually holds — the difference is orphaned objects, and it is
not zero.

### The dashboards are read-only

They are files in the repository, not objects in Grafana's database. "Save As" to
experiment, but a change only persists by going back into the repo. This is
deliberate: a dashboard someone tuned during an incident and forgot about is worse
than no dashboard.

---

## If Grafana will not let you in

"User does not have a role" means your account lacks `llmbot-admin`. That is the
gate working. Ask an administrator to assign the role in Keycloak, then sign in
again.
