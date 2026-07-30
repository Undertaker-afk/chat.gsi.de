"""The public status page.

Two pages, modelled on githubstatus.com: the front page answers "is it working
right now", and /history is the permanent record, grouped by month.

Rendered with plain string building rather than a template engine. The page is
small and static in shape, and the dependency would be larger than the code it
replaces -- consistent with the rest of this repo (hand-written S3 client,
hand-written Prometheus registry).

Everything user-supplied or model-supplied is escaped. Incident text comes from
an LLM, and text from a model is untrusted input like any other: it reaches this
page automatically, with no human in between.
"""

from __future__ import annotations

import html
import json
from datetime import datetime, timezone
from typing import Any

from .kuma import DayStat
from .store import Incident

BANNER = {
    "operational":    ("All Systems Operational", "#1a7f37", "ok"),
    # Slow but working. Blue rather than amber on purpose: amber is the colour of
    # "something is broken", and this is the colour of "something is annoying".
    "degraded":       ("Degraded Performance", "#0969da", "warn"),
    # Down on purpose. Grey-blue, because a deployment is not a fault and should
    # not compete visually with one.
    "maintenance":    ("Under Maintenance", "#6639ba", "warn"),
    "partial_outage": ("Partial System Outage", "#bf8700", "warn"),
    "major_outage":   ("Major System Outage", "#cf222e", "bad"),
    "partial_unknown": ("Mostly Operational", "#57606a", "unknown"),
    "unknown":        ("Status Unknown", "#57606a", "unknown"),
}

SEVERITY_LABEL = {"minor": "Minor", "major": "Major", "critical": "Critical",
                  "degraded": "Degraded", "maintenance": "Maintenance"}
STATUS_LABEL = {"investigating": "Investigating", "identified": "Identified",
                "monitoring": "Monitoring", "resolved": "Resolved",
                "degraded": "Degraded Performance", "maintenance": "Maintenance"}

CSS = """
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d1d9e0;--card:#fff;
      --ok:#1a7f37;--warn:#bf8700;--bad:#cf222e;--none:#d0d7de}
@media (prefers-color-scheme:dark){
  :root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;
        --ok:#3fb950;--warn:#d29922;--bad:#f85149;--none:#30363d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
     font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;
       flex-wrap:wrap;margin-bottom:28px}
h1{font-size:19px;margin:0;font-weight:600}
nav a{color:var(--muted);text-decoration:none;margin-left:18px;font-size:14px}
nav a:hover,nav a.on{color:var(--fg)}
.banner{border-radius:8px;padding:18px 20px;color:#fff;font-size:19px;font-weight:600;
        margin-bottom:8px}
.sub{color:var(--muted);font-size:13px;margin-bottom:28px}
.card{border:1px solid var(--line);border-radius:8px;background:var(--card);margin-bottom:24px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;
     padding:14px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.row:last-child{border-bottom:0}
.name{font-weight:500}
.pill{font-size:12px;padding:2px 9px;border-radius:20px;border:1px solid var(--line);
      color:var(--muted)}
.pill.ok{color:var(--ok);border-color:var(--ok)}
.pill.bad{color:var(--bad);border-color:var(--bad)}
.bars{display:flex;gap:2px;width:100%;margin-top:10px}
.bar{flex:1;height:30px;border-radius:2px;background:var(--none);min-width:2px}
.bar.ok{background:var(--ok)}.bar.warn{background:var(--warn)}.bar.bad{background:var(--bad)}
.scale{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}
.inc{padding:18px;border-bottom:1px solid var(--line)}
.inc:last-child{border-bottom:0}
.inc h3{margin:0 0 4px;font-size:16px;font-weight:600}
.meta{color:var(--muted);font-size:13px;margin-bottom:10px}
.upd{border-left:2px solid var(--line);padding:0 0 0 14px;margin:12px 0}
.upd b{font-size:13px}
.upd time{color:var(--muted);font-size:12px;margin-left:8px}
.upd p{margin:4px 0 0}
.sev{font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;
     border-radius:4px;color:#fff;margin-right:8px}
.sev.minor{background:var(--warn)}.sev.major{background:#d1242f}.sev.critical{background:#82071e}
.month{margin:32px 0 12px;font-size:15px;font-weight:600;padding-bottom:6px;
       border-bottom:1px solid var(--line)}
.empty{color:var(--muted);padding:18px;font-size:14px}
footer{color:var(--muted);font-size:12px;margin-top:40px;border-top:1px solid var(--line);
       padding-top:16px}
.ai{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:4px;
    padding:1px 6px;margin-left:8px}
"""


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def page(title: str, body: str, active: str) -> str:
    def nav(href: str, label: str, key: str) -> str:
        return f'<a href="{href}" class="{"on" if active == key else ""}">{label}</a>'
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)}</title><style>{CSS}</style></head><body><div class="wrap">
<header><h1>chat.gsi.de status</h1><nav>
{nav('/', 'Current', 'current')}{nav('/history', 'Incident history', 'history')}
{nav('/api/status.json', 'API', 'api')}</nav></header>
{body}
<footer>Updated automatically from Uptime Kuma. Incident text is written by an AI
agent from monitoring data; timings and affected components are measured, not
generated.</footer>
</div></body></html>"""


def render_current(snapshot: dict[str, Any], uptime: dict[int, list[DayStat]],
                   overall_uptime: dict[int, float | None]) -> str:
    label, colour, _ = BANNER[snapshot["overall"]]
    parts = [f'<div class="banner" style="background:{colour}">{esc(label)}</div>']

    poll = snapshot["last_poll"]
    when = poll.strftime("%Y-%m-%d %H:%M UTC") if poll else "never"
    bits = [f"Last checked {esc(when)}"]
    if not snapshot["monitors"]:
        bits.append("no checks configured in Uptime Kuma yet")
    elif snapshot.get("monitors_pending"):
        pending = ", ".join(snapshot["monitors_pending"][:4])
        bits.append(f"waiting for the first check of {esc(pending)}")
    elif not snapshot["kuma_seen"]:
        bits.append("waiting for Uptime Kuma to record its first check")
    if not snapshot["ai_available"]:
        bits.append("AI writer unavailable — using plain summaries")
    parts.append(f'<div class="sub">{" · ".join(bits)}</div>')

    if snapshot["open_incidents"]:
        parts.append('<div class="card">')
        for inc in snapshot["open_incidents"]:
            parts.append(render_incident(inc))
        parts.append("</div>")

    parts.append('<div class="card">')
    monitors = snapshot["monitors"]
    if not monitors:
        parts.append('<div class="empty">No monitors configured yet. Add checks in '
                     'Uptime Kuma and they will appear here automatically.</div>')
    for m in monitors:
        pill = "ok" if m.is_up else ("bad" if m.is_down else "")
        state = "Operational" if m.is_up else ("Down" if m.is_down else "Pending")
        pct = overall_uptime.get(m.id)
        pct_text = f"{pct * 100:.2f}% uptime" if pct is not None else "no data yet"
        parts.append(
            f'<div class="row"><span class="name">{esc(m.name)}</span>'
            f'<span><span class="pill">{esc(pct_text)}</span> '
            f'<span class="pill {pill}">{esc(state)}</span></span>'
            f'<div class="bars">{_bars(uptime.get(m.id, []))}</div>'
            f'<div class="scale"><span>90 days ago</span><span>today</span></div></div>')
    parts.append("</div>")
    return page("chat.gsi.de status", "\n".join(parts), "current")


def _bars(days: list[DayStat]) -> str:
    out = []
    for d in days:
        ratio = d.ratio
        if ratio is None:
            cls, tip = "", f"{d.day}: not monitored"
        elif ratio >= 0.999:
            cls, tip = "ok", f"{d.day}: no downtime"
        elif ratio >= 0.95:
            cls, tip = "warn", f"{d.day}: {(1 - ratio) * 100:.1f}% of checks failed"
        else:
            cls, tip = "bad", f"{d.day}: {(1 - ratio) * 100:.1f}% of checks failed"
        out.append(f'<div class="bar {cls}" title="{esc(tip)}"></div>')
    return "".join(out)


def render_incident(inc: Incident, heading: str = "h3") -> str:
    sev = SEVERITY_LABEL.get(inc.severity, inc.severity)
    opened = _fmt(inc.opened_at)
    meta = [f"{esc(opened)}"]
    if inc.resolved_at:
        mins = inc.duration_minutes
        meta.append(f"resolved after {mins} min" if mins else "resolved")
    else:
        meta.append(STATUS_LABEL.get(inc.status, inc.status))
    if inc.components:
        meta.append("affected: " + esc(", ".join(inc.components)))

    updates = []
    for u in inc.updates:
        badge = '<span class="ai">AI</span>' if u.ai_written else ""
        updates.append(
            f'<div class="upd"><b>{esc(STATUS_LABEL.get(u.status, u.status))}</b>'
            f'<time>{esc(_fmt(u.at))}</time>{badge}'
            f'<p>{esc(u.body)}</p></div>')

    return (f'<div class="inc">'
            f'<{heading}><span class="sev {esc(inc.severity)}">{esc(sev)}</span>'
            f'{esc(inc.title)}</{heading}>'
            f'<div class="meta">{" · ".join(meta)}</div>'
            f'{"".join(updates)}</div>')


def render_history(incidents: list[Incident]) -> str:
    if not incidents:
        body = ('<div class="card"><div class="empty">No incidents recorded. '
                'Nothing has failed a check since this page started watching.</div></div>')
        return page("Incident history — chat.gsi.de", body, "history")

    by_month: dict[str, list[Incident]] = {}
    for inc in incidents:
        key = _fmt(inc.opened_at, "%B %Y")
        by_month.setdefault(key, []).append(inc)

    parts = []
    for month, group in by_month.items():
        parts.append(f'<div class="month">{esc(month)}</div><div class="card">')
        for inc in group:
            parts.append(render_incident(inc))
        parts.append("</div>")
    return page("Incident history — chat.gsi.de", "\n".join(parts), "history")


def status_json(snapshot: dict[str, Any], overall_uptime: dict[int, float | None]) -> str:
    return json.dumps({
        "status": snapshot["overall"],
        "description": BANNER[snapshot["overall"]][0],
        "updated_at": (snapshot["last_poll"].isoformat() if snapshot["last_poll"] else None),
        "components": [{
            "name": m.name,
            "status": "operational" if m.is_up else ("down" if m.is_down else "pending"),
            "uptime_90d": overall_uptime.get(m.id),
            "last_check": m.last_beat.isoformat() if m.last_beat else None,
        } for m in snapshot["monitors"]],
        "open_incidents": [{
            "id": i.id, "title": i.title, "severity": i.severity, "status": i.status,
            "opened_at": i.opened_at, "components": i.components,
            "updates": [{"at": u.at, "status": u.status, "body": u.body,
                         "ai_written": u.ai_written} for u in i.updates],
        } for i in snapshot["open_incidents"]],
        "sources": {
            "uptime_kuma": snapshot["kuma_seen"],
            "prometheus": snapshot["prometheus"],
            "ai_writer": snapshot["ai_available"],
        },
    }, indent=2)


def _fmt(iso: str, fmt: str = "%Y-%m-%d %H:%M UTC") -> str:
    try:
        return datetime.fromisoformat(iso).astimezone(timezone.utc).strftime(fmt)
    except (ValueError, TypeError):
        return str(iso)
