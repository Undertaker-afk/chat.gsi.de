# Getting started

## What this is

An assistant that answers questions about GSI's internal documentation. It does
not know things in general — it reads the GSI wiki, the virgo HPC user guide and
www.gsi.de, and answers from those. Every claim it makes carries a numbered
citation you can click to see the page it came from.

That constraint is the point. If the corpus does not contain an answer, it says so
rather than inventing one.

## Logging in

1. Open **http://chat.lab**.
2. You are redirected to Keycloak. Sign in with your GSI account.
3. You land in an empty conversation.

You need the **`llmbot-user`** role to get past the login. If you see a refusal
after signing in successfully, your account exists but has not been given the role
— ask an administrator.

Your session is a cookie holding nothing but an opaque ID. Tokens stay on the
server; the browser never holds a credential that would work anywhere else.

## The interface

```
┌────────────┬──────────────────────────────────────────────┐
│ Sidebar    │                                              │
│            │              Messages                        │
│ Heute      │                                              │
│  · Slurm…  │   You: How do I submit a job?               │
│  · Lustre… │   Assistant: Use sbatch [1] …               │
│ Gestern    │                                              │
│  · …       ├──────────────────────────────────────────────┤
│            │  [+]  Ask something…            [Fast ▾] [→] │
│ ─────────  │  Durchsucht: Linux, IT, Main                 │
│ ⚙ Account  │                                              │
└────────────┴──────────────────────────────────────────────┘
```

- **Sidebar** — your conversations, grouped by *Heute / Gestern / Letzte 7 Tage /
  Älter*. Rename or delete one from its hover menu.
- **Composer** — one line until your text wraps, then it grows and the controls
  move below it.
- **`+` button** — attach an image, or pick one from your last 10 uploads.
- **Mode picker** — `Fast` or `Deep`. See [Asking questions](chatting.md).
- **Under the composer** — *"Durchsucht: …"* names the knowledge bases being
  searched for you. If something is missing from that list, that is why the
  assistant does not know about it.
- **Account menu** (bottom left) — *Einstellungen* always; *Verwaltung* and
  *Administration* appear only if you hold the corresponding role.

## Your first question

Ask something the wiki actually covers. Good first questions:

- *Wie reiche ich einen Job auf virgo ein?*
- *What is the Lustre quota on /lustre/rz?*
- *Wie beantrage ich einen Linux-Account?*

You will see a short status line while it retrieves, then the answer streams in
with `[1]`, `[2]` markers. Hover a marker to see the page title and section; click
it to open the source. A collapsible source list sits under the answer.

## Keyboard

| Key | Does |
|---|---|
| `Enter` | Send |
| `Shift+Enter` | New line |
| Paste an image | Attaches it |

## What to do when an answer is wrong

Use the 👍/👎 buttons under the message. That feedback is stored and is the only
honest signal anyone gets about whether retrieval is finding the right pages —
it is worth the two seconds.

If the answer is wrong because the *source page* is wrong, fix the wiki. The
assistant will pick the change up on the next crawl of that source.

## Next

- [Asking questions](chatting.md) — get more out of it
- [What you can search](access-and-knowledge-bases.md) — why some topics are missing
