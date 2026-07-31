#!/usr/bin/env python3
"""Package the chat-gsi chart and push it to ttl.sh with a 6h TTL.

    python3 helm_push.py                 # push ./chart to oci://ttl.sh/<repo>
    python3 helm_push.py --repo my-name  # choose the ttl.sh path
    python3 helm_push.py --ttl 2h        # a different lifetime

ttl.sh is an anonymous, EPHEMERAL OCI registry: an artifact is deleted after its
TTL, which ttl.sh reads from the image TAG. `helm push` tags with the chart
version (semver), which ttl.sh does not recognise as a duration, so it would get
the 1h default. To get 6h we add a second tag that IS a duration (`6h`) with
`oras`; that tag is what carries the 6-hour lifetime and what Flux references.

Nothing here is secret: the chart injects credentials from values at install
time, so what lands on ttl.sh is infrastructure templates only. It is still a
PUBLIC registry — treat the pushed URL as shareable, and note it self-destructs.

Requires: helm, and (for the custom TTL) oras — https://oras.land/docs/installation
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

REGISTRY = "ttl.sh"
# Stable by default so the Flux OCIRepository can reference a fixed URL across
# pushes. ttl.sh is public+anonymous, so pick something distinctive; override
# with --repo or TTLSH_REPO for a less guessable path.
DEFAULT_REPO = os.environ.get("TTLSH_REPO", "chat-gsi-de")
CHART_DIR = "chart"
CHART_NAME = "chat-gsi"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print(f"$ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, check=True, **kw)


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def chart_version() -> str:
    out = subprocess.run(
        ["helm", "show", "chart", CHART_DIR], capture_output=True, text=True, check=True
    ).stdout
    for line in out.splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip()
    raise SystemExit("could not read chart version from Chart.yaml")


def main() -> int:
    ap = argparse.ArgumentParser(description="push the chat-gsi chart to ttl.sh")
    ap.add_argument("--repo", default=DEFAULT_REPO, help=f"ttl.sh path (default {DEFAULT_REPO})")
    ap.add_argument("--ttl", default="6h", help="lifetime tag ttl.sh honours (default 6h)")
    ap.add_argument("--chart", default=CHART_DIR, help="chart directory")
    args = ap.parse_args()

    if not have("helm"):
        raise SystemExit("helm not found on PATH")
    if not os.path.isdir(args.chart):
        raise SystemExit(f"chart dir not found: {args.chart} (run from the repo root)")

    version = chart_version()
    base = f"{REGISTRY}/{args.repo}/{CHART_NAME}"
    print(f"\nchart {CHART_NAME} {version} -> oci://{REGISTRY}/{args.repo}\n")

    with tempfile.TemporaryDirectory() as tmp:
        run(["helm", "package", args.chart, "-d", tmp])
        tgz = glob.glob(os.path.join(tmp, f"{CHART_NAME}-*.tgz"))[0]

        # The canonical helm push: creates <base>:<version> (ttl.sh default 1h).
        run(["helm", "push", tgz, f"oci://{REGISTRY}/{args.repo}"])

        # Add the duration tag so ttl.sh keeps it for --ttl. oras retags the
        # artifact already in the registry; no re-upload of the layers.
        if have("oras"):
            run(["oras", "tag", f"{base}:{version}", args.ttl])
            ref = f"{base}:{args.ttl}"
            ttl_note = f"lives ~{args.ttl}"
        else:
            ref = f"{base}:{version}"
            ttl_note = "lives ~1h (install oras for the 6h tag: https://oras.land)"
            print("\n! oras not found — skipping the duration tag; TTL falls back to 1h.")

    print("\n" + "=" * 68)
    print(f"pushed:  oci://{ref}   ({ttl_note})")
    print("pull:    helm pull oci://" + ref.replace(f":{args.ttl}", "") +
          (f" --version {args.ttl}" if have("oras") else f" --version {version}"))
    print("\nFlux OCIRepository ref:")
    print(f"  url: oci://{base}")
    print(f"  ref: {{ tag: {ref.rsplit(':', 1)[1]} }}")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"\ncommand failed ({exc.returncode}): {' '.join(exc.cmd)}", file=sys.stderr)
        raise SystemExit(1)
