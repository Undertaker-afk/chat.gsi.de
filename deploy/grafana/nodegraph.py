#!/usr/bin/env python3
"""
Rebuilds the Overview node graph and its bottleneck table.

Run from the repo root:  python3 deploy/grafana/nodegraph.py

## What was wrong with the old one

Every node showed a rate in its own unit -- req/s beside auth/min beside "pages
this run". Nothing was comparable, so the graph proved traffic existed and never
said where it was struggling. There was no saturation signal anywhere on it.

## The model this uses instead

A network weathermap: **nodes carry health, edges carry throughput.**

Each component's node value is its SATURATION -- p95 latency as a percentage of a
budget for that hop. 100% means the component is at the limit we consider
acceptable, so one number is comparable across Postgres, the LLM proxy and object
storage even though their absolute latencies differ by four orders of magnitude.
That comparability is the whole point: the bottleneck is simply the reddest node.

Budgets are opinions and belong in the open, not buried in a query string:

  postgres  100 ms   a slow query at this corpus size means a missing index
  valkey     10 ms   in-memory, same node; more than this is a fault
  storage   500 ms   SeaweedFS on local-path, one object
  keycloak  500 ms   a token exchange nobody should be waiting on
  embed       5 s    a batch of 32, measured at 0.6 s healthy
  llm        30 s    the GSI proxy under load, and the ceiling for one turn
  external   20 s    fetching and parsing a PDF from Indico
  http        2 s    what a user notices

## Why one query per frame

Grafana's nodeGraph wants exactly two frames, and a Prometheus query yields one
value column. Multiple stats per node would need a joinByField on `id` -- which
the edges frame also has, so the join would swallow it. Hence one number per
node, and it is the one worth having.
"""

import json
import pathlib

# id, label, p95 histogram (None = nothing to measure), budget seconds
COMPONENTS = [
    ("frontend", "Frontend", "chatgsi_http_request_duration_seconds_bucket", 2.0),
    ("postgres", "Postgres", "chatgsi_db_query_duration_seconds_bucket", 0.1),
    ("valkey", "Valkey", None, None),
    ("storage", "Object storage", "chatgsi_s3_operation_duration_seconds_bucket", 0.5),
    ("keycloak", "Keycloak", "chatgsi_keycloak_probe_duration_seconds_bucket", 0.5),
    ("embed", "Embeddings", "chatgsi_embedding_duration_seconds_bucket", 5.0),
    ("llm", "LLM proxy", "chatgsi_llm_request_duration_seconds_bucket", 30.0),
    ("external", "Indico / Repository", "chatgsi_document_read_duration_seconds_bucket", 20.0),
    ("crawler", "Crawler", None, None),
    ("browser", "Browser", None, None),
]

# id, source, target, throughput expr, unit shown under the number
EDGES = [
    ("e_browser_frontend", "browser", "frontend",
     "sum(rate(chatgsi_http_requests_total[$__rate_interval]))", "req/s"),
    ("e_frontend_keycloak", "frontend", "keycloak",
     "sum(rate(chatgsi_auth_events_total[$__rate_interval]))", "auth/s"),
    ("e_frontend_postgres", "frontend", "postgres",
     "sum(rate(chatgsi_db_queries_total[$__rate_interval]))", "queries/s"),
    ("e_frontend_valkey", "frontend", "valkey",
     "sum(rate(chatgsi_valkey_commands_total[$__rate_interval]))", "ops/s"),
    ("e_frontend_storage", "frontend", "storage",
     "sum(rate(chatgsi_s3_bytes_total[$__rate_interval]))", "bytes/s"),
    ("e_frontend_embed", "frontend", "embed",
     "sum(rate(chatgsi_embedding_requests_total[$__rate_interval]))", "calls/s"),
    ("e_frontend_llm", "frontend", "llm",
     "sum(rate(chatgsi_llm_requests_total[$__rate_interval]))", "calls/s"),
    ("e_frontend_external", "frontend", "external",
     "sum(rate(chatgsi_document_reads_total[$__rate_interval]))", "docs/s"),
    ("e_embed_llm", "embed", "llm",
     "sum(rate(chatgsi_embedding_inputs_total[$__rate_interval]))", "inputs/s"),
    ("e_crawler_postgres", "crawler", "postgres",
     "sum(rate(chatgsi_crawl_runs_total[$__rate_interval]))", "runs/s"),
    ("e_crawler_embed", "crawler", "embed",
     'sum(rate(chatgsi_embedding_inputs_total{direction="document"}[$__rate_interval]))',
     "inputs/s"),
]


def relabel(expr, labels):
    for key, value in labels.items():
        expr = f'label_replace({expr}, "{key}", "{value}", "", "")'
    return expr


def p95(bucket):
    return f"histogram_quantile(0.95, sum by (le) (rate({bucket}[$__rate_interval])))"


def saturation(bucket, budget):
    """
    p95 as a percentage of budget, clamped so one stall cannot blow the scale.

    The trailing `>= 0` is load-bearing: histogram_quantile over a histogram with
    no observations in the window returns NaN, not absence, so `or vector(0)`
    never fires and the panel renders a blank bar for every idle component. NaN
    fails every comparison, so `>= 0` drops it and lets the fallback through.
    """
    return f"(clamp_max(({p95(bucket)}) / {budget} * 100, 200) >= 0)"


def nodes_expr():
    parts = []
    for cid, title, bucket, budget in COMPONENTS:
        if bucket:
            value = f"({saturation(bucket, budget)} or vector(0))"
            sub = f"% of {budget * 1000:.0f}ms budget" if budget < 1 else f"% of {budget:.0f}s budget"
        else:
            # No latency instrumented. Zero rather than absent: a missing node and
            # an idle node look identical on a graph and mean different things.
            value = "vector(0)"
            sub = "not measured"
        parts.append(relabel(value, {"id": cid, "title": title, "subTitle": sub}))
    return "\n  or\n".join(parts)


def edges_expr():
    parts = []
    for eid, source, target, expr, unit in EDGES:
        parts.append(
            relabel(
                f"({expr} or vector(0))",
                {"id": eid, "source": source, "target": target, "subTitle": unit},
            )
        )
    return "\n  or\n".join(parts)


def bottleneck_expr():
    """Every component's saturation, for the table beside the graph."""
    parts = []
    for cid, title, bucket, budget in COMPONENTS:
        if not bucket:
            continue
        parts.append(
            relabel(f"({saturation(bucket, budget)} or vector(0))", {"component": title})
        )
    return "\n  or\n".join(parts)


NODE_GRAPH = {
    "id": 900,
    "type": "nodeGraph",
    "title": "Data flow and saturation",
    "datasource": {"type": "prometheus", "uid": "prometheus"},
    "gridPos": {"h": 13, "w": 16, "x": 0, "y": 0},
    "description": (
        "A weathermap: edges carry throughput, nodes carry health. A node's number "
        "is its p95 latency as a PERCENTAGE OF ITS OWN BUDGET, which is what makes "
        "Postgres and the LLM proxy comparable on one screen despite latencies four "
        "orders of magnitude apart — the bottleneck is the highest number. Over 100% "
        "means that hop is slower than we consider acceptable; the budgets are listed "
        "in deploy/grafana/nodegraph.py. Nodes reading 0 with 'not measured' have no "
        "latency instrumentation, not zero latency. Built entirely from Prometheus "
        "with label_replace, so there is no topology source to keep in sync."
    ),
    "targets": [
        {
            "refId": "nodes",
            "datasource": {"type": "prometheus", "uid": "prometheus"},
            "expr": nodes_expr(),
            "format": "table",
            "instant": True,
        },
        {
            "refId": "edges",
            "datasource": {"type": "prometheus", "uid": "prometheus"},
            "expr": edges_expr(),
            "format": "table",
            "instant": True,
        },
    ],
    "transformations": [
        {
            "id": "organize",
            "options": {
                "excludeByName": {
                    "Time": True, "job": True, "instance": True, "__name__": True,
                    "service": True, "stack": True, "window": True, "outcome": True,
                    "direction": True, "le": True,
                },
                "renameByName": {"Value": "mainStat"},
            },
        }
    ],
    "fieldConfig": {"defaults": {"unit": "short", "decimals": 1, "custom": {}}, "overrides": []},
    "options": {
        "nodes": {"mainStatUnit": "percent"},
        "edges": {"mainStatUnit": "short"},
        "zoomMode": "cooperative",
    },
}

BOTTLENECK_TABLE = {
    "id": 901,
    "type": "bargauge",
    "title": "Where the time goes",
    "datasource": {"type": "prometheus", "uid": "prometheus"},
    "gridPos": {"h": 13, "w": 8, "x": 16, "y": 0},
    "description": (
        "The same saturation numbers as the graph, ranked. Read the top bar as "
        "'this is the component to look at first'. Anything under 50% is comfortable; "
        "over 100% means that hop is exceeding the budget set for it, which is a "
        "judgement call written down in deploy/grafana/nodegraph.py rather than a "
        "law of nature."
    ),
    "targets": [
        {
            "refId": "A",
            "datasource": {"type": "prometheus", "uid": "prometheus"},
            "expr": bottleneck_expr(),
            "format": "time_series",
            "instant": True,
            "legendFormat": "{{component}}",
        }
    ],
    "fieldConfig": {
        "defaults": {
            "unit": "percent",
            "decimals": 0,
            "min": 0,
            "max": 200,
            "thresholds": {
                "mode": "absolute",
                "steps": [
                    {"color": "green", "value": None},
                    {"color": "yellow", "value": 50},
                    {"color": "orange", "value": 80},
                    {"color": "red", "value": 100},
                ],
            },
        },
        "overrides": [],
    },
    "options": {
        "displayMode": "gradient",
        "orientation": "horizontal",
        "showUnfilled": True,
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
        "sortBy": "Value",
        "sortOrder": "Descending",
    },
}


if __name__ == "__main__":
    path = pathlib.Path("deploy/grafana/dashboards/overview.json")
    dashboard = json.loads(path.read_text())

    panels = [p for p in dashboard["panels"] if p.get("id") not in (900, 901)]
    panels = [p for p in panels if p.get("type") != "nodeGraph"]
    dashboard["panels"] = [NODE_GRAPH, BOTTLENECK_TABLE] + panels

    path.write_text(json.dumps(dashboard, indent=1) + "\n")
    print(f"rebuilt the node graph and bottleneck panel in {path}")
