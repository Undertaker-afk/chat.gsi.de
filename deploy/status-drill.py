#!/usr/bin/env python3
"""Drive the status page through real degraded / outage / maintenance events.

Run from the repo root (needs kubectl pointed at the lab cluster):

    make -f k8s/Makefile.k8s status-drill
    python3 deploy/status-drill.py --phase maintenance --keep   # one phase, no cleanup

WHY THIS EXISTS
---------------
The classifier's branches are unit-tested with synthetic heartbeats, but that
stubs out the two things that only fail in production: whether the agent LOOP
opens the incident the branch describes, and whether the LLM writer narrates it.
This drill exercises the whole path with real signal -- Kuma genuinely observes a
slow or dead target, the agent genuinely classifies and publishes, the writer
genuinely writes -- and asserts the right kind of incident appears each time.

HOW IT STAYS HONEST
-------------------
It never injects heartbeats or edits the store to fake a verdict. It only makes a
throwaway target (k8s/90-status-drill.yaml) actually slow, actually offline, or
actually mid-rollout, and then watches what the running agent decides. The target
is deleted and its incidents purged at the end.

It runs ON THE OPERATOR HOST and does all its work through kubectl, so it puts no
build or workload load on the Fedora box (AGENTS.md #1): it only flips files,
sets an env var, and waits.

Because the thresholds are real (2 min slow, 3 min down), the full run takes
~12-18 minutes. That is the cost of testing with real signal; --phase runs one.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from datetime import datetime, timezone

# --- knobs (mirror statuspage/app/classify.py + agent.py, with slack) --------

NS = "chat-gsi"
POD = "deploy/uptime-kuma"
AGENT_C = "agent"                      # the statuspage container in the kuma pod
TARGET = "deploy/status-drill-target"
MANIFEST = "k8s/90-status-drill.yaml"

MONITOR_NAME = "Drill target (test)"
# In-cluster Service DNS on purpose: this target has no Traefik route and only
# Kuma (in the same cluster) ever checks it. The ".lab hostname" rule in
# provision.py is about REAL monitors reaching the app the way a user does; a
# synthetic internal target is the documented exception.
MONITOR_URL = "http://status-drill-target.chat-gsi.svc.cluster.local:8080/"
INTERVAL = 20                          # Kuma's floor; keeps beats/streaks moving

WARMUP_S = 80                          # >= 3 healthy beats so a baseline exists
DEGRADED_TIMEOUT = 260                 # DEGRADED_AFTER_S(120) + Kuma + poll slack
OUTAGE_TIMEOUT = 300                   # OUTAGE_AFTER_S(180) + slack
MAINT_TIMEOUT = 360                    # 180s down + rollout detection + slack
RECOVER_TIMEOUT = 160                  # RESOLVE_AFTER(3) beats + poll
SLOW_MS = 1500                         # over DEGRADED_FLOOR_MS(1000) with room to
                                       # spare, and far over 3x a ~13 ms baseline.
                                       # Still well under the monitor's 10 s
                                       # timeout, so Kuma records a SLOW SUCCESS
                                       # -- a timeout would be a down beat and the
                                       # phase would assert the wrong thing.


class DrillError(RuntimeError):
    pass


# --- kubectl plumbing --------------------------------------------------------


def kubectl(*args: str, check: bool = True, capture: bool = False) -> str:
    cmd = ["kubectl", "-n", NS, *args]
    if capture:
        r = subprocess.run(cmd, text=True, capture_output=True)
        if check and r.returncode != 0:
            raise DrillError(f"{' '.join(cmd)}\n{r.stderr.strip()}")
        return r.stdout.strip()
    r = subprocess.run(cmd)
    if check and r.returncode != 0:
        raise DrillError(f"command failed: {' '.join(cmd)}")
    return ""


def agent(*args: str, check: bool = True) -> int:
    """Run app.drilltools inside the agent container; stream its output."""
    cmd = ["kubectl", "-n", NS, "exec", POD, "-c", AGENT_C, "--",
           "python", "-m", "app.drilltools", *args]
    return subprocess.run(cmd).returncode if not check else _run_checked(cmd)


def _run_checked(cmd: list[str]) -> int:
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise DrillError(f"drill step failed: {' '.join(cmd[6:])}")
    return 0


def target_state(mode: str | None = None, ready: str | None = None) -> None:
    """Flip the running target's monitored/readiness state via /state files.

    No rollout: this writes files the running pod reads per request, so slow and
    dead are pure app-level changes -- which is the outage the maintenance path
    must NOT mistake for a deploy.
    """
    parts = []
    if mode is not None:
        parts.append(f"printf '%s' '{mode}' > /state/mode")
    if ready is not None:
        parts.append(f"printf '%s' '{ready}' > /state/ready")
    if parts:
        kubectl("exec", TARGET, "--", "sh", "-c", " && ".join(parts))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def banner(text: str) -> None:
    print(f"\n{'=' * 4} {text} {'=' * (72 - len(text))}", flush=True)


def wait(seconds: int, why: str) -> None:
    print(f"  ... {why} ({seconds}s)", flush=True)
    time.sleep(seconds)


# --- setup / teardown --------------------------------------------------------


def setup() -> None:
    banner("SETUP  applying the throwaway target and test monitor")
    kubectl("apply", "-f", MANIFEST)
    kubectl("rollout", "status", TARGET, "--timeout=90s")
    agent("add-monitor", "--name", MONITOR_NAME, "--url", MONITOR_URL,
          "--interval", str(INTERVAL))
    # Make sure it starts from a clean, healthy baseline.
    target_state(mode="ok", ready="ok")


def teardown(keep: bool) -> None:
    if keep:
        banner("KEEP  leaving the target, monitor and incidents in place")
        print("  clean up later with: make -f k8s/Makefile.k8s status-drill-clean")
        return
    banner("CLEANUP  removing the monitor, its incidents and the target")
    # Order matters: purge/delete the monitor while the agent is still up, then
    # drop the target. Best-effort -- a failed cleanup step must not mask a result.
    for step in (
        lambda: agent("del-monitor", "--name", MONITOR_NAME, check=False),
        lambda: agent("purge", "--name", MONITOR_NAME, check=False),
        lambda: kubectl("delete", "-f", MANIFEST, "--ignore-not-found", check=False),
    ):
        try:
            step()
        except Exception as exc:  # noqa: BLE001
            print(f"  cleanup step failed (continuing): {exc}", file=sys.stderr)


# --- phases ------------------------------------------------------------------


def phase_baseline() -> None:
    banner("BASELINE  healthy target, establishing a response-time baseline")
    target_state(mode="ok", ready="ok")
    wait(WARMUP_S, "letting healthy beats accumulate")
    agent("await", "--component", MONITOR_NAME, "--expect", "ok",
          "--timeout", "30")
    print("  baseline established.")


def phase_degraded() -> None:
    banner("DEGRADED  target answers slowly for > 2 min")
    since = now_iso()
    target_state(mode=f"slow {SLOW_MS}")
    agent("await", "--component", MONITOR_NAME, "--expect", "degraded",
          "--timeout", str(DEGRADED_TIMEOUT), "--since", since)
    banner("RECOVER  target fast again")
    target_state(mode="ok")
    agent("await", "--component", MONITOR_NAME, "--expect", "ok",
          "--timeout", str(RECOVER_TIMEOUT))


def phase_outage() -> None:
    banner("OUTAGE  target offline for > 3 min, pod still Ready (no rollout)")
    since = now_iso()
    # ready stays "ok": the pod is Ready, only the monitored path fails. kube.py
    # sees no rollout -> this must classify as outage, not maintenance.
    target_state(mode="dead", ready="ok")
    agent("await", "--component", MONITOR_NAME, "--expect", "outage",
          "--timeout", str(OUTAGE_TIMEOUT), "--since", since)
    banner("RECOVER  target back up")
    target_state(mode="ok")
    agent("await", "--component", MONITOR_NAME, "--expect", "ok",
          "--timeout", str(RECOVER_TIMEOUT))


def phase_maintenance() -> None:
    banner("MAINTENANCE  target down AND mid-rollout (never-Ready new pod)")
    since = now_iso()
    # A real spec change -> Recreate rollout. The new pod comes up dead AND
    # never-Ready, so the rollout stays in progress (unavailableReplicas=1) for
    # the whole window: kube.py reports a rollout on every poll, and once the
    # target has been down past the outage threshold the verdict is maintenance,
    # not outage. This is the one phase that needs a genuine deploy.
    kubectl("set", "env", TARGET, "DRILL_MODE=dead", "DRILL_READY=notready")
    agent("await", "--component", MONITOR_NAME, "--expect", "maintenance",
          "--timeout", str(MAINT_TIMEOUT), "--since", since)


PHASES = {
    "baseline": phase_baseline,
    "degraded": phase_degraded,
    "outage": phase_outage,
    "maintenance": phase_maintenance,
}
ORDER = ["baseline", "degraded", "outage", "maintenance"]


def main() -> int:
    ap = argparse.ArgumentParser(description="status-page incident drill")
    ap.add_argument("--phase", choices=ORDER, action="append",
                    help="run only this phase (repeatable); default runs all")
    ap.add_argument("--keep", action="store_true",
                    help="do not clean up (for inspecting the result)")
    ap.add_argument("--no-setup", action="store_true",
                    help="assume the target and monitor already exist")
    args = ap.parse_args()

    phases = args.phase or ORDER
    # baseline first if anything time-sensitive follows and it was not asked for
    if "baseline" not in phases and any(p in phases for p in ("degraded",)):
        phases = ["baseline", *phases]

    started = time.monotonic()
    failures: list[str] = []
    try:
        if not args.no_setup:
            setup()
        else:
            target_state(mode="ok", ready="ok")
        for name in ORDER:
            if name not in phases:
                continue
            try:
                PHASES[name]()
                print(f"  PASS: {name}")
            except DrillError as exc:
                print(f"  FAIL: {name}: {exc}", file=sys.stderr)
                failures.append(name)
                # Reset the target so the next phase starts from healthy.
                try:
                    target_state(mode="ok", ready="ok")
                except Exception:  # noqa: BLE001
                    pass
    finally:
        teardown(args.keep)

    mins = (time.monotonic() - started) / 60
    banner(f"DONE  in {mins:.1f} min")
    if failures:
        print(f"  FAILED phases: {', '.join(failures)}")
        return 1
    print("  all phases passed: every event produced the right kind of incident.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DrillError as exc:
        print(f"drill aborted: {exc}", file=sys.stderr)
        raise SystemExit(2)
    except KeyboardInterrupt:
        print("\ninterrupted -- run `make -f k8s/Makefile.k8s status-drill-clean` to clean up",
              file=sys.stderr)
        raise SystemExit(130)
