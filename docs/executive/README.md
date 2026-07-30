# Executive documentation

Four short documents. Read them in order; each is a page or two.

| Doc | Question it answers |
|---|---|
| [Overview](overview.md) | What is this, what does it do, and why was it built this way? |
| [Delivery status](delivery-status.md) | What is finished, what is proven, what is missing? |
| [Risk and access control](risk-and-access.md) | Who can see what, and what could go wrong? |
| [Production readiness](production-readiness.md) | What stands between this and real use? |

## The one-paragraph version

chat.gsi.de answers questions about GSI's internal documentation — the Foswiki, the
virgo HPC user guide, www.gsi.de — with citations back to the source page. It is
built so that it can only answer from documents it has actually indexed, and only
from documents the person asking is permitted to see. It currently runs on a
single lab machine as a working prototype: complete end to end, verified against
live systems, and not yet hardened for production. The gap between the two is
small, specific and listed in [Production readiness](production-readiness.md).

## The honest summary

**What is genuinely good here.** The access-control model is enforced in the
database query rather than bolted on afterwards, so a document someone may not see
cannot influence an answer or leak through a citation. The observability is
unusually complete for a prototype — 262 dashboard panels over a single metrics
endpoint, with every query verified rather than assumed. The status page is
deliberately independent of the system it reports on, and its AI writes prose but
never facts.

**What is not finished.** There is no automated test suite. There is no TLS. Two
components (Keycloak, the observability stack) hold state that does not survive a
restart or is not backed up. It runs on one laptop-class node with no redundancy.

None of that is hidden anywhere in these documents.
