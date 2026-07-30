# Asking questions

## Fast or Deep

The mode picker in the composer offers two.

| | `gsi-fast` | `gsi-deep` |
|---|---|---|
| How it works | one retrieval, one answer | breaks your question into sub-questions, researches each in parallel, then synthesises |
| Typical wait | a few seconds to first word | 30–90 seconds, up to a 3-minute ceiling |
| Use for | "what is the command", "where is X documented" | "compare A and B", "what do I need end-to-end to do X" |

**Fast is the default and is right most of the time.** Deep is worth the wait when
the answer has to come from several pages that nobody wrote together.

In Deep mode a collapsible **agent trace** appears: the rounds, the sub-questions
it decided to ask, and each sub-agent's state. It opens while running and folds
away when done. Watching it is how a 40-second wait stays legible rather than
looking like a hang.

Deep mode stops at 3 rounds and 4 sub-agents per round, with a 180-second wall
clock. If it hits the clock it answers from what it has and marks the answer
partial — it will not silently truncate.

## Where answers come from

Two places, and the interface distinguishes them because they carry different
weight.

**The documentation** — the crawled wiki, virgo docs and www.gsi.de. This is the
main source and it states how things are.

**External documents** — talks and slides on Indico, publications in the GSI
repository, and PDFs that documentation pages link to. Searched automatically on
every question. A line under the answer says what was found:

> 📄 **Externe Dokumente** · 2 · *1 gelesen*

Two things to notice there:

- **"1 gelesen"** — how many were actually downloaded and read. The rest are
  pointers: we know the document exists and where, and no more.
- **"nur Metadaten"** in amber on a source means exactly that. The publication
  repository blocks automated downloads, so for those we have the title, authors
  and journal reference and have never seen the document. The assistant is not
  permitted to claim anything about what such a document says.

A talk is one person's account on one day. When it disagrees with the
documentation, the documentation wins — and the assistant is told to say so
rather than quietly picking one.

If nothing relevant turns up, the line says so instead of disappearing. "Indico
has nothing on this" is a real answer.

## Citations

Numbers like `[3]` are inline links.

- **Hover** — the page title and the heading within it.
- **Click** — opens the source page, anchored to the section.
- **Under the answer** — the full source list, collapsible.

If a chunk was found by three different sub-agents, it is still `[3]` once. The
numbering is per answer.

**No citations means no sources.** If an answer arrives without any, treat it with
suspicion and check the wiki yourself.

## Editing a question

Hover one of your own messages and click the edit button. Saving does **not**
overwrite anything — it branches the conversation. A `< 2 / 2 >` pager appears so
you can move between versions, and the original question and its answer stay
intact.

Use this instead of re-asking in a new message when you want to rephrase: the
model then sees a clean question rather than a conversation about how you phrased
it.

## Attaching images

Both chat models can read images.

- **Paste** a screenshot straight into the composer, or
- click **`+`** → **Hochladen** to pick a file, or
- click **`+`** → **Verlauf ›** to re-attach one of your last 10 uploads.

Re-attaching from history costs no storage — the message points at an image that
already exists. Removing an image from the composer does not delete it either; it
may still belong to an older message. Delete for real from
*Einstellungen → Speicher*.

Useful for: an error dialog, a plot you want explained, a screenshot of a config
you cannot copy out of.

Limits: 10 MiB per file, and it counts against your quota. See
[Files and storage](files-and-storage.md).

## Conversation titles

After your first exchange the system names the conversation itself — six words or
fewer, in the language you asked in. It is generated *after* the answer, so it
never delays anything. Rename it from the sidebar if you disagree.

## Getting better answers

- **Name the thing.** "Slurm" and "virgo" retrieve better than "the cluster".
- **One question at a time in Fast mode.** Two unrelated questions in one message
  gets you one retrieval that suits neither. Deep mode handles this properly.
- **Say what you already tried.** It goes into the query and pulls in the error
  message's page.
- **Check the "Durchsucht" line** if it claims not to know something. It may
  simply not be allowed to look there —
  [What you can search](access-and-knowledge-bases.md).
