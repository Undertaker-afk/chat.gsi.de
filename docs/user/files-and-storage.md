# Files and storage

Three kinds of thing take up your space, and they share one budget.

| Kind | Where it comes from | Where you manage it |
|---|---|---|
| **Uploads** | images you attached | *Einstellungen → Speicher* |
| **Chats** | your messages, titles, agent traces | delete a conversation from the sidebar |
| **Generated files** | code, Markdown and PDFs the assistant wrote | the **Dateien** page |

## Your quota

**1 GiB by default, covering uploads and chats together.** The settings dialog
shows it as one stacked bar:

```
[███████ uploads ██████][████ chats ████][           free            ]
      orange                  green                   grey
```

When you are full, both uploading and sending a message fail with an explicit
message telling you the actual numbers — not a generic error. Free space by
deleting uploads or old conversations.

Two details worth knowing:

- **An upload you never sent still counts.** Attaching an image and then closing
  the tab leaves it on your quota. Clear it from *Einstellungen → Speicher*.
- **Deleting a conversation reclaims its attachments too.** They go together.

## Uploads

- **Images** (png, jpeg, webp, gif) — the assistant looks at them directly.
- **Documents** (PDF, pptx, docx, xlsx, odp, odt, ods) — the text is extracted
  server-side and the assistant reads it, so you can ask questions *about* an
  attached slide deck rather than only re-opening it.
- **4 MiB per file.**
- Uploaded the moment you attach them, not when you send.
- A document with no text layer — a scanned PDF, say — is stored and viewable but
  cannot be read by the assistant. It says so rather than pretending.
- Downloads go through a link that is signed fresh for each request and expires
  after five minutes. What is stored in your message is a stable reference, so
  nothing on record ever rots — but a URL you copied out of the address bar will
  stop working, which is intended.

## Generated files

When the assistant writes something substantial — a Slurm batch script, a
Markdown summary, a generated PDF — it becomes a file you keep, on the **Dateien**
page.

The page has three panes:

- **left** — filter by kind: all, code, Markdown, PDF
- **middle** — the file list
- **right** — the viewer

Both left panes collapse, so a Slurm script or a PDF page can take the full
width. That is usually what you want.

You can **view** (syntax-highlighted for code, rendered for Markdown and PDF),
**download**, and **delete**. Generated files survive the conversation they came
from being deleted — deliberately, because the script is often the thing you
wanted and the conversation was just how you got it.

## Where the bytes actually live

Uploads and generated files go to object storage (SeaweedFS, S3 API), not into
the database. Your messages live in Postgres. This matters to you in exactly one
way: the storage side scales independently, so "the file store is full" and "the
database is full" are different problems with different fixes.
