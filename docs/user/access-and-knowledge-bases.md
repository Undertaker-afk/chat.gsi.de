# What you can search

The assistant does not search "the wiki". It searches the **knowledge bases you
have been granted**, and nothing else.

## What a knowledge base is

One per Foswiki web — `Linux`, `IT`, `CSFramework`, `AcceleratorControls`, and so
on, around 28 of them — plus one each for the non-wiki sources (`virgo-docs`,
`www`).

Some are marked **default**. Every user with `llmbot-user` gets those without
belonging to any group, so a new account is useful on day one.

## How you get more

```
what you can search  =  the default knowledge bases
                     +  for each group you belong to:
                          whatever that group grants you
```

Two levels decide that second part:

1. An **administrator** sets a **ceiling** for a group — the most that group may
   ever reach.
2. The **group's manager** decides how much of that ceiling each member actually
   gets.

A manager can only ever narrow the ceiling, never widen it. Nobody can grant
themselves anything. A new member starts with the full ceiling until the manager
customises them.

## Seeing what you have

The line under the composer names it:

> Durchsucht: Linux, IT, Main

That is the whole list. It is not editable — not by you, not by a manager for
themselves. If a topic you expect is missing from that line, that is the reason
the assistant does not know about it, and the fix is a person, not a better
prompt.

## Asking for access

Ask your **group's manager** first — they can grant anything inside their group's
ceiling immediately. If what you need is outside it, they need an administrator to
raise the ceiling.

Every grant is logged with who did it and when, so "who gave them access?" has an
answer.

## If access is taken away

Losing a knowledge base hides every conversation that cited it: it disappears from
your sidebar and its URL stops working. It is **hidden, not deleted**, for 30
days — a revocation made by mistake is fully repairable in that window. After 30
days the conversations and their attachments are purged for real.

## Why it is enforced the way it is

The filter is applied inside the database query that fetches candidate passages,
before ranking. A passage you may not see never enters the process at all, so it
cannot influence the answer and cannot leak through a citation. Deep mode inherits
the same list — sub-agents get exactly what you get.

With no grants at all, the assistant says so plainly instead of answering from
nothing.
