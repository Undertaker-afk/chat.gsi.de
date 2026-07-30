#!/usr/bin/env python3
"""
Collapses every dashboard row except the first.

Run from the repo root:  python3 deploy/grafana/collapse.py

## The problem this fixes

The dashboards were not badly laid out -- every row had sensible gridPos -- but
every row was EXPANDED. Overview alone was 86 grid units tall, so opening it gave
you 39 panels in one continuous scroll with no landmarks. Ten dashboards, 262
panels, all like that. More information than anyone reads is the same as none.

Grafana renders a collapsed row as a single clickable header, so leaving the
first row open and folding the rest turns each dashboard into: the summary you
always want, then a short index of everything else. Nothing is deleted; it is one
click away and the click is a decision to go looking.

## The part that is easy to get wrong

A collapsed row owns its children -- they move INTO `row["panels"]` and out of
the dashboard's top-level list. An expanded row leaves them at the top level and
is only a header. Writing `collapsed: true` without moving the panels produces a
dashboard whose rows are closed and whose panels are all still visible under
them, which looks like a rendering bug.
"""

import json
import pathlib

DASHBOARDS = pathlib.Path("deploy/grafana/dashboards")


def collapse(dashboard: dict) -> tuple[int, int]:
    panels = dashboard.get("panels", [])

    # Anything before the first row is the header block -- on Overview that is the
    # node graph and the bottleneck bars. It has no row to belong to and stays put.
    first_row = next((i for i, p in enumerate(panels) if p.get("type") == "row"), None)
    if first_row is None:
        return 0, 0

    header = panels[:first_row]
    rest = panels[first_row:]

    # Split into (row, its children) in document order.
    groups: list[tuple[dict, list[dict]]] = []
    for panel in rest:
        if panel.get("type") == "row":
            # A row that was already collapsed carries its children with it.
            children = panel.pop("panels", [])
            groups.append((panel, list(children)))
        elif groups:
            groups[-1][1].append(panel)

    y = max((p.get("gridPos", {}).get("y", 0) + p.get("gridPos", {}).get("h", 0)
             for p in header), default=0)

    out = list(header)
    collapsed_count = 0
    for index, (row, children) in enumerate(groups):
        row["gridPos"] = {"h": 1, "w": 24, "x": 0, "y": y}
        # The first row stays open: it is the one people came for.
        keep_open = index == 0
        row["collapsed"] = not keep_open
        y += 1

        if keep_open:
            row["panels"] = []
            out.append(row)
            # Children keep their relative layout, re-anchored under the row.
            base = min((c.get("gridPos", {}).get("y", 0) for c in children), default=0)
            for child in children:
                grid = child.setdefault("gridPos", {"h": 8, "w": 12, "x": 0})
                grid["y"] = y + (grid.get("y", 0) - base)
                out.append(child)
            y += max((c.get("gridPos", {}).get("y", 0) - y + c.get("gridPos", {}).get("h", 0)
                      for c in children), default=0)
        else:
            base = min((c.get("gridPos", {}).get("y", 0) for c in children), default=0)
            for child in children:
                grid = child.setdefault("gridPos", {"h": 8, "w": 12, "x": 0})
                grid["y"] = y + (grid.get("y", 0) - base)
            row["panels"] = children
            out.append(row)
            collapsed_count += 1

    dashboard["panels"] = out
    return len(groups), collapsed_count


if __name__ == "__main__":
    for path in sorted(DASHBOARDS.glob("*.json")):
        dashboard = json.loads(path.read_text())
        total, collapsed = collapse(dashboard)
        path.write_text(json.dumps(dashboard, indent=1) + "\n")
        visible = len([p for p in dashboard["panels"] if p.get("type") != "row"])
        print(
            f"{path.name:<15} rows={total:<3} collapsed={collapsed:<3} "
            f"panels visible on open={visible}"
        )
