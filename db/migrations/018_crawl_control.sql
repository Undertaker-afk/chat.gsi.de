-- 018: crawl control, scheduling, and run telemetry.
--
-- Three things at once, because they are one feature:
--
--   1. crawl_control  -- what the admin UI wants a source to be doing. The
--      frontend still cannot start a process (see 011); it writes intent here
--      and the crawler reads it. Pause and stop work the same way: there is no
--      signal to send to a container the web app cannot see, so the running
--      crawl polls this table at page boundaries instead.
--
--   2. an INTERVAL per source, so "how often does this crawl" stops being a
--      systemd unit on somebody's laptop and becomes a value an admin can set.
--      The timer that used to run `crawl` now runs `crawler tick`, which asks
--      this table what is due.
--
--   3. enough counters on crawl_runs to answer "what did that run actually do"
--      without reading the log of a pod that has since been garbage-collected.
--      These are also what the Grafana crawler dashboard is built from.

-- --- run telemetry -----------------------------------------------------------

ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS pages_skipped     int NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS pages_restricted  int NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS pages_failed      int NOT NULL DEFAULT 0;
-- Pages a changed-only run skipped WITHOUT fetching, because the source's own
-- revision marker was unchanged. This is the number that shows the mode paying
-- for itself: at a 5 s crawl delay each one is five seconds not spent.
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS pages_unfetched   int NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS chunks_written    int NOT NULL DEFAULT 0;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS bytes_fetched     bigint NOT NULL DEFAULT 0;
-- 'incremental' (fetch everything, compare content hashes), 'changed-only'
-- (skip the fetch when the source says the page has not changed), 'full'
-- (re-embed regardless), 'skip-existing' (never revisit a known page).
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS mode              text NOT NULL DEFAULT 'incremental';
-- Written every few seconds by the running crawl. Two uses: the admin UI shows
-- live progress instead of a spinner, and a run whose heartbeat has gone stale
-- is distinguishable from one that is merely slow -- a crawl of the wiki
-- legitimately takes hours, so elapsed time alone proves nothing.
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS heartbeat_at      timestamptz;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS requested_by      text;

-- 'stopped' is a new terminal state: an admin pressed Stop. Deliberately NOT
-- folded into 'failed' -- a stopped run has incomplete discovery and must never
-- be read as evidence that the missing pages are gone (see the sweep guard in
-- pipeline.py, and the 145 documents it cost the one time it was absent).
ALTER TABLE crawl_runs DROP CONSTRAINT IF EXISTS crawl_runs_status_check;
ALTER TABLE crawl_runs ADD CONSTRAINT crawl_runs_status_check
    CHECK (status IN ('running','ok','failed','partial','stopped','paused'));

-- --- change detection without a fetch ----------------------------------------

-- The source's own revision marker for this document: an ETag or Last-Modified
-- for the HTML connector, a topic revision for Foswiki. Stored so the NEXT run
-- can compare it against what discovery reports and skip the fetch entirely.
--
-- content_hash cannot do this job: computing it requires the page body, which
-- is exactly the request we are trying to avoid.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS revision      text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_modified timestamptz;

-- --- control and scheduling --------------------------------------------------

CREATE TABLE IF NOT EXISTS crawl_control (
    source_id         bigint PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,

    -- What the admin wants. The crawler polls this at page boundaries.
    --   running -- crawl normally
    --   paused  -- a running crawl waits here; a scheduled crawl does not start
    desired_state     text NOT NULL DEFAULT 'running'
                      CHECK (desired_state IN ('running','paused')),

    -- Set by Stop, cleared when the crawler acknowledges it. A timestamp rather
    -- than a boolean so a stop issued after the current run ended cannot leak
    -- into the next one: the crawler ignores any stop older than its own start.
    stop_requested_at timestamptz,
    stop_requested_by text,

    -- NULL means no automatic schedule; the source is crawled only on request.
    interval_minutes  int CHECK (interval_minutes IS NULL OR interval_minutes >= 15),
    -- The mode automatic runs use. Manual requests carry their own.
    mode              text NOT NULL DEFAULT 'changed-only'
                      CHECK (mode IN ('incremental','changed-only','full','skip-existing')),
    -- When the next automatic run is due. Advanced by the crawler after each
    -- run, so a long crawl cannot queue a second one behind itself.
    next_run_at       timestamptz,

    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        text
);

-- Every source gets a control row, so the UI never has to special-case "not
-- configured yet" and the crawler can read state with a plain join.
INSERT INTO crawl_control (source_id)
SELECT id FROM sources
ON CONFLICT (source_id) DO NOTHING;

-- Manual requests carry the mode they were queued with, so "crawl only what
-- changed" from the UI is not silently downgraded to a full incremental pass.
ALTER TABLE crawl_requests ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'incremental';
-- Set when the request finishes, so the queue distinguishes "claimed and still
-- running" from "claimed, done" without joining crawl_runs.
ALTER TABLE crawl_requests ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE crawl_requests ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- Due-schedule lookup, run by every `crawler tick` (every few minutes).
CREATE INDEX IF NOT EXISTS crawl_control_due
    ON crawl_control (next_run_at)
    WHERE interval_minutes IS NOT NULL AND desired_state = 'running';

-- Live-progress lookup for the admin UI and the metrics collector: "is anything
-- running right now, and how far along is it".
CREATE INDEX IF NOT EXISTS crawl_runs_running
    ON crawl_runs (source_id, started_at DESC)
    WHERE status = 'running';
