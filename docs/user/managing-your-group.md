# Managing your group

For holders of **`llmbot-privileged`**. The account menu shows **Verwaltung**.

## What you can and cannot do

You can decide **how much of your group's ceiling each member gets**.

You cannot create groups, change the ceiling, add or remove people, or touch
anything outside the groups you manage. Those are administrator jobs — see
[Administration](administration.md).

The distinction exists so that delegating access does not mean delegating the
ability to widen it.

## The page

*Verwaltung* shows only the groups you manage. Pick one and you get its members
and, for each, the knowledge bases they can reach.

```
Person              Zugriff                          Leitung
─────────────────────────────────────────────────────────────
A. Beispiel         [x] Linux [x] IT [ ] Main        —
M. Muster           volle Gruppenrechte              ✓
```

Two states matter and they are different:

- **volle Gruppenrechte** — not customised. This member gets whatever the group's
  ceiling is, and *automatically gains* anything an administrator adds to it later.
- **customised** — an explicit subset. This member gets exactly the boxes you
  ticked, and adding to the ceiling later does not reach them.

Once you tick or untick a box for someone, they become customised. To hand them
back to "full group rights" use the reset control rather than ticking everything —
ticking everything freezes them at today's ceiling.

That distinction is why unticking a manager's last box does not silently restore
full access: "customised to nothing" is a real state and is respected.

## Making a change

1. Pick the group.
2. Tick or untick knowledge bases per person.
3. **Speichern**. Nothing takes effect until you save; **Verwerfen** throws the
   staged changes away.

Changes apply to the member's next question. An in-flight answer is not affected.

## The checkboxes are a convenience, not the boundary

You only see knowledge bases inside your group's ceiling, but that is the UI being
helpful. The server independently rejects any grant outside the ceiling regardless
of what a client sends. You cannot exceed it by accident or by trying.

## What gets logged

Every grant, revoke, membership change and manager change writes an entry with
your name, the action, the target and the time. Administrators can read it in
*Administration → Protokoll*. Assume everything you do here is attributable,
because it is.

## Removing access

Read [If access is taken away](access-and-knowledge-bases.md#if-access-is-taken-away)
before you do it. Revoking a knowledge base hides the member's conversations that
cited it — recoverable for 30 days, permanent after that. It is not a light action
if the person has been using the system.
