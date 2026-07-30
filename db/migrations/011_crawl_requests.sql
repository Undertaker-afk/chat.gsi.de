-- 011: crawl requests from the admin UI.
--
-- The frontend runs in its own container and cannot start the crawler, which is
-- a separate image launched by podman on the host. Rather than give the web app
-- a socket into the container runtime -- a large hole for a small button -- the
-- admin page queues a request here and the crawl unit claims it
-- (`crawler crawl --requested`, run by a short systemd timer alongside the
-- existing weekly one).
--
-- The claim is a single UPDATE ... RETURNING, so two crawlers racing on the same
-- request cannot both win it.

CREATE TABLE crawl_requests (
    id            bigserial PRIMARY KEY,
    source_id     bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    requested_by  text NOT NULL,
    requested_at  timestamptz NOT NULL DEFAULT now(),
    force         boolean NOT NULL DEFAULT false,
    skip_existing boolean NOT NULL DEFAULT false,
    -- NULL until a crawler claims it; then the run it produced.
    started_at    timestamptz,
    run_id        bigint REFERENCES crawl_runs(id) ON DELETE SET NULL
);

-- Pending requests only: the queue is scanned constantly and finished rows are
-- kept for the audit trail.
CREATE INDEX crawl_requests_pending ON crawl_requests (source_id) WHERE started_at IS NULL;
