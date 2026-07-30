# Administration

For holders of **`llmbot-admin`**. The account menu shows **Administration**.

Six sections down the left: **Gruppen**, **Mitglieder**, **Wissensbasen**,
**Quellen**, **Protokoll**, **Statistik**.

---

## Gruppen — access ceilings

A group is a set of people plus a **ceiling**: the most any member of it may ever
reach.

- Create a group with a name and description.
- Tick the knowledge bases that form its ceiling.
- The count next to each shows how many pages are indexed in it, so you are not
  granting a name you cannot size.

The ceiling is what a manager works inside. Raising it lets managers grant more;
lowering it revokes from everyone who had the removed base — including
retroactively hiding their conversations, so read
[If access is taken away](access-and-knowledge-bases.md#if-access-is-taken-away)
first.

## Mitglieder — people and managers

Add realm users to a group and mark who leads it.

The user list comes from Keycloak through a **read-only** service account that
holds `view-users` and nothing else. Consequently:

- **Role assignment is a Keycloak console job.** This page shows roles; it cannot
  change them. Giving someone `llmbot-privileged` happens in Keycloak, and only
  then does *Verwaltung* appear for them.
- A user appears here once they exist in the realm, whether or not they have ever
  logged in.

Marking someone **Leitung** makes them a manager of that group — they can then set
per-member grants inside its ceiling. That is the only power the flag confers.

## Wissensbasen — the public baseline

One row per Foswiki web plus one per non-wiki source. The **Standard** switch
decides whether every `llmbot-user` gets it without belonging to any group.

Keep this set to things that are genuinely for everyone. It is the difference
between a new account being useful on day one and being useless until someone
notices.

---

## Quellen — crawls

The operationally interesting page. One card per source (`wiki`, `virgo-docs`,
`www`).

### Starting a crawl

Pick a **mode**, press **Crawl starten**.

| Mode | Label | What it does | When |
|---|---|---|---|
| `changed-only` | **Nur Geändertes** | asks the source for a revision and does not even download unchanged pages | the default; gentlest on the source |
| `incremental` | **Inkrementell** | downloads everything, compares content hashes | when the source gives no revision info |
| `skip-existing` | **Nur Neues** | never revisits a known page | fast, but blind to edits |
| `full` | **Vollständig** | re-downloads and re-embeds everything | only after an embedding-model change |

**The button does not start a process.** It writes the request to the database,
and a scheduler that runs every five minutes picks it up. The card shows
**eingereiht** until it does — that is normal, not a hang. You can take it back
out with **Aus Warteschlange nehmen**.

### While it runs

The card shows a progress bar and live counters, refreshed every three seconds:
pages seen, changed, not-fetched, failed, chunks written, and how long it has been
going.

- The percentage is estimated from the previous run. On a source's **first** crawl
  there is nothing to compare against and it says so.
- **kein Lebenszeichen seit …** means the crawler stopped reporting and has
  probably died. The next scheduler pass reaps it.

### Pause, resume, stop

- **Pause** / **Fortsetzen** — takes effect at the next page boundary, which is
  the only point where nothing is half-written. Expect up to one page of delay.
  A paused crawl is still alive; it holds its place.
- **Stopp** — ends the run for good. It asks for confirmation.

**A stopped run never deletes anything.** A normal crawl removes pages it did not
see this time; a stopped one only saw the pages before you pressed the button, so
everything after that point would look deleted. That sweep is skipped entirely.
Verified: stopping a wiki crawl at 202 of ~460 pages deleted nothing.

### Automatik-Crawl — the schedule

**Automatik-Crawl** sets the interval (hourly to monthly, or off) and
**Modus für Automatik** the mode it runs in. Press **Intervall speichern**.

The card then shows when the next run is due. The interval lives in the database,
not in a systemd unit or a Kubernetes manifest — changing it is this dropdown and
nothing else.

### Reading the footer

```
1274 Seiten indexiert   1231 mit Revision   zuletzt 29.07.2026, 14:03   ✓ fertig
```

**mit Revision** is the one to watch. `changed-only` can only skip a page it has a
stored revision for, and a page acquires one by being crawled once. Until that
number is close to the page count, the mode will not save you much — and the card
says so explicitly rather than leaving you to wonder.

Whether it helps at all depends on the source:

| Source | Sends | Effect of `changed-only` |
|---|---|---|
| `virgo-docs` | ETag + Last-Modified | full benefit — measured 205 s → 5 s, 40 of 41 pages skipped |
| `www` | sitemap `<lastmod>` | request skipped when the date matches |
| `wiki` | nothing | falls back to a normal incremental crawl |

`wiki.gsi.de` sends no revision information at all, so `changed-only` there is a
safe no-op. That is the correct behaviour, not a fault — but do not expect it to
speed up the wiki.

### Letzte Läufe

Expands to the run history: start, mode, status, and counts for seen / changed /
not-fetched / deleted / chunks. Failed runs show their error inline.

The **gelöscht** column is worth watching. A number wildly out of line with
previous runs means the crawler saw far less of the source than usual, which is
the failure mode most likely to quietly degrade the corpus.

---

## Protokoll — the audit log

Every grant, revoke, membership change, manager change and crawl trigger, with
actor, action, target and timestamp.

This is the first thing anyone wants the day someone asks "who gave them access?".

## Statistik

Corpus and usage counts: documents, chunks, conversations, users, storage.

For anything deeper — response times, crawl throughput, storage trends, logs —
use Grafana. See [Dashboards and status](status-page.md).
