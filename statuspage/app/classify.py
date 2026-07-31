"""
Deciding what kind of event we are looking at.

Three outcomes, in the order the thresholds fire:

    degraded     responding, but slowly, for DEGRADED_AFTER_S      (2 min)
    outage       not responding at all for OUTAGE_AFTER_S          (3 min)
    maintenance  not responding, and Kubernetes says it is a rollout

## Where the line between code and model sits

The thresholds are code because they were specified as numbers: two minutes, three
minutes. The *classification* is the model's -- given a component, how long it has
been failing, what the check reported and what Kubernetes says is happening to
that workload, it decides whether this reads as maintenance or as an outage, and
writes it.

That split is deliberate and it is the same one the rest of this agent uses. A
model deciding *whether* something is wrong makes the page unreliable, because
nothing is reproducible and a quiet model means silence during an outage. A model
deciding *how to describe* a situation the code already detected is exactly what
a model is good at, and every path here has a deterministic fallback if it is
unavailable.

## Why "slow" is relative

These checks answer in 11-14 ms. A fixed threshold alone would never fire on a
healthy-but-degrading service, and a fixed "3x" alone would fire on 13 ms -> 40 ms,
which nobody would call degradation. So it is both: a multiple of the component's
own recent median AND an absolute floor of one second, and it has to be sustained
rather than a single slow sample.

The floor is what a reader would call slow: anything answering in under a second
is not worth a status-page entry, however far it has drifted from its own habit.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

#: Slow for this long before it is worth telling anyone. The user asked for 2 min.
DEGRADED_AFTER_S = 120

#: Down for this long before it is an outage. The user asked for 3 min.
OUTAGE_AFTER_S = 180

#: How much slower than its own baseline counts as slow.
DEGRADED_FACTOR = 3.0

#: ...and never below this, so 13 ms -> 40 ms is not "degraded". One second is
#: the number the user asked for: below it nobody calls the service slow, and a
#: floor low enough to fire on 300 ms would report degradations no reader
#: recognises. The drill answers in 1.5 s to sit clearly above it.
DEGRADED_FLOOR_MS = 1000.0

#: Baseline window. Long enough to be a habit, short enough to follow real change.
BASELINE_WINDOW_S = 6 * 3600

#: A verdict needs more than two samples or one slow beat looks sustained.
MIN_SAMPLES = 3


@dataclass
class Verdict:
    kind: str  # "ok" | "degraded" | "outage" | "maintenance"
    component: str
    #: How long the condition has held, in seconds.
    duration_s: int
    #: What the check last said, verbatim. Never paraphrased before the model.
    detail: str
    #: Set for maintenance: the workload Kubernetes says is in motion.
    rollout: str | None = None
    #: Set for degraded: the numbers behind the verdict.
    response_ms: float | None = None
    baseline_ms: float | None = None

    @property
    def is_incident(self) -> bool:
        return self.kind in ("degraded", "outage", "maintenance")


def is_up(beat: dict) -> bool:
    """Whether a heartbeat says the component answered.

    Accepts Kuma's integer code and its readable name. Deliberately tolerant:
    this comparison being wrong does not raise, it just quietly turns every
    verdict into "outage" and stops degradation from ever being reported. That
    happened -- `recent_beats` returned "up" while every check here tested
    `== 1` -- and it was invisible until a drill asked for a slow service and
    got silence. A page that fails loudly is recoverable; one that fails silently
    is worse than no page.
    """
    return beat.get("status") in (1, "up")


def _at(beat: dict) -> datetime | None:
    raw = beat.get("at")
    if not raw:
        return None
    try:
        value = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _without_current_slow_run(beats: list[dict]) -> list[dict]:
    """
    Drop the newest unbroken run of healthy-but-over-the-floor beats.

    Without this the baseline eats the very slowness it is meant to measure
    against. Slow beats are *healthy* beats, so once a slow run outnumbers the
    fast history the median becomes the slow value, the threshold jumps to three
    times it, and the degradation stops registering -- roughly 100 s into a
    condition that has to last 120 s to be reported. Observed exactly that way:
    twelve consecutive 1510 ms beats produced no incident at all.

    Left unfixed it does not merely break the drill. A real component that stays
    slow long enough normalises itself, an open degradation resolves while it is
    still slow (`_still_slow` asks this same question), and the page says
    everything is fine.

    The run is anchored on DEGRADED_FLOOR_MS, an absolute number, so this stays
    non-circular: the floor decides which beats are *candidates* for being slow,
    and the beats before them decide whether they actually are.
    """
    for index, beat in enumerate(sorted(beats, key=lambda b: str(b.get("at") or ""),
                                        reverse=True)):
        ping = beat.get("ping_ms")
        if not is_up(beat) or ping is None or float(ping) < DEGRADED_FLOOR_MS:
            return sorted(beats, key=lambda b: str(b.get("at") or ""), reverse=True)[index:]
    # Every beat we hold is over the floor: this component has no faster habit on
    # record, so there is nothing to compare against and the caller gets None.
    return []


def baseline_ms(beats: list[dict]) -> float | None:
    """
    The component's own habit: median response time over healthy recent beats,
    ignoring a slow spell that is still going (see `_without_current_slow_run`).

    Median, not mean -- one 8-second stall during a deploy would drag a mean up
    far enough to hide the degradation this is meant to catch.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=BASELINE_WINDOW_S)
    values = [
        float(b["ping_ms"])
        for b in _without_current_slow_run(beats)
        if b.get("ping_ms") is not None
        and is_up(b)
        and (_at(b) or cutoff) >= cutoff
    ]
    return statistics.median(values) if len(values) >= MIN_SAMPLES else None


def sustained_slow_seconds(beats: list[dict], baseline: float) -> tuple[int, float | None]:
    """
    How long the most recent run of slow-but-up beats has lasted.

    Walks backwards from newest and stops at the first beat that is not slow, so
    an old slow patch that has since recovered cannot trigger anything.
    Returns (seconds, worst response time in the run).
    """
    threshold = max(baseline * DEGRADED_FACTOR, DEGRADED_FLOOR_MS)
    now = datetime.now(timezone.utc)

    newest: datetime | None = None
    oldest: datetime | None = None
    worst: float | None = None
    count = 0

    for beat in sorted(beats, key=lambda b: str(b.get("at") or ""), reverse=True):
        ping = beat.get("ping_ms")
        when = _at(beat)
        if not is_up(beat) or ping is None or when is None:
            break
        if float(ping) < threshold:
            break
        newest = newest or when
        oldest = when
        worst = max(worst or 0.0, float(ping))
        count += 1

    if count < MIN_SAMPLES or oldest is None:
        return 0, None
    # To NOW rather than to the newest beat: a run that is still going has been
    # going for as long as it has been going, not until the last poll.
    return int((now - oldest).total_seconds()), worst


def down_seconds(beats: list[dict]) -> int:
    """How long the current unbroken run of failures has lasted."""
    now = datetime.now(timezone.utc)
    oldest: datetime | None = None

    for beat in sorted(beats, key=lambda b: str(b.get("at") or ""), reverse=True):
        if is_up(beat):
            break
        when = _at(beat)
        if when is None:
            break
        oldest = when

    return int((now - oldest).total_seconds()) if oldest else 0


def classify(
    *,
    component: str,
    beats: list[dict],
    detail: str,
    rollout: str | None,
    in_maintenance: bool,
) -> Verdict:
    """
    One component's verdict.

    Order matters. Explicit maintenance set in Kuma wins outright -- somebody
    stated their intent and no inference should override it. Otherwise an outage
    outranks degradation, because a component that is down is not also slow.
    """
    down = down_seconds(beats)

    if in_maintenance:
        return Verdict("maintenance", component, down, detail, rollout="in Uptime Kuma gesetzt")

    if down >= OUTAGE_AFTER_S:
        # The rollout check is what separates "it broke" from "we are deploying
        # it". Without Kubernetes reachable, `rollout` is None and this stays an
        # outage -- the honest answer when we cannot tell.
        if rollout:
            return Verdict("maintenance", component, down, detail, rollout=rollout)
        return Verdict("outage", component, down, detail)

    if down > 0:
        # Failing, but not for long enough to report. Deliberately silent: most
        # blips resolve inside three minutes and reporting them trains people to
        # ignore the page.
        return Verdict("ok", component, down, detail)

    base = baseline_ms(beats)
    if base:
        slow_for, worst = sustained_slow_seconds(beats, base)
        if slow_for >= DEGRADED_AFTER_S:
            return Verdict(
                "degraded", component, slow_for, detail, response_ms=worst, baseline_ms=base
            )

    return Verdict("ok", component, 0, detail)
