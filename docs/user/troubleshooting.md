# Troubleshooting

**Start at `http://status.lab`.** If it reports an outage, the problem is known
and being reported — nothing below will help.

## Signing in

**"You do not have access" after signing in successfully.**
Your account is fine; it lacks the `llmbot-user` role. An administrator assigns it
in Keycloak.

**The login page loops back to itself.**
Usually a stale cookie. Clear cookies for `chat.lab` and `keycloak.lab` and retry.
If it persists, it is a server-side configuration problem — report it.

**Logged out unexpectedly.**
Sessions are refreshed automatically while you use the system. Being logged out
after a long idle period is expected; being logged out mid-conversation is not
and is worth reporting.

## Answers

**"I could not find anything about that in the sources."**
Taken at face value, this is the system working. Check in order:

1. The **"Durchsucht:"** line under the composer. Is the relevant area listed? If
   not, you have not been granted it —
   [What you can search](access-and-knowledge-bases.md).
2. Does the page actually exist in the wiki? The assistant only knows what has
   been crawled.
3. Was the page written recently? Sources are crawled on a schedule, so a page
   added this morning may not be indexed yet.
4. Try naming the thing more specifically. "virgo" and "Slurm" retrieve where
   "the cluster" does not.

**The answer is wrong but cites a real page.**
Open the citation. Usually the page itself is out of date — fix the wiki, and the
next crawl picks it up. If the page is right and the answer misread it, use 👎.

**The answer has no citations at all.**
Treat it with suspicion and verify before acting on it.

**Deep mode is taking forever.**
It has a hard 3-minute ceiling and will answer from whatever it found, marked
partial. Open the agent trace to see what it is doing. If you only needed a
command, Fast mode would have answered in seconds.

**An answer stopped mid-sentence.**
The connection dropped. Ask again — nothing is corrupted.

## Files and uploads

**Upload rejected.**
Three possible reasons, and the message says which: over 10 MiB, not an image, or
your quota is full.

**Quota full.**
Uploads and chats share 1 GiB. Free space in *Einstellungen → Speicher* (uploads)
or by deleting old conversations. Remember that an image you attached but never
sent still counts.

**A download link stopped working.**
Links expire after five minutes by design. Go back to the message or the
**Dateien** page and click again to get a fresh one. Do not bookmark them.

**A conversation vanished from the sidebar.**
Most likely your access to a knowledge base it cited was revoked. It is hidden,
not deleted, and is recoverable for 30 days — ask your group manager.

## Speed

**Everything is slow.**
Check `http://status.lab`. If everything is green, it is probably load on the
shared LLM proxy, which is not exclusive to this system.

**Fast mode is slow.**
It targets a few seconds to first word. Consistently worse than that is worth
reporting, with a rough time of day.

## Reporting a problem

Include: what you asked, what you expected, what you got, roughly when, and
whether `status.lab` was green at the time. The last one saves the most work —
it separates "the system was broken" from "the system was fine and this is a real
bug".
