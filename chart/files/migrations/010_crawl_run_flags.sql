-- 010: record how a crawl run was invoked.
--
-- `make crawl-skip-existing` and `make crawl-force` produce runs whose numbers
-- look wrong without this context -- a skip-existing run legitimately reports
-- thousands seen and nothing changed. Storing the flags next to the counters
-- makes the run self-explanatory in `make status` instead of only in whatever
-- terminal happened to launch it.
--
-- FORCE is a non-reserved keyword in Postgres, so it is usable unquoted as a
-- column name; kept for symmetry with the CLI flag it records.

ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS force         boolean NOT NULL DEFAULT false;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS skip_existing boolean NOT NULL DEFAULT false;
