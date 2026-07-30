-- 007: attachment bytes move out of Postgres into object storage (SeaweedFS S3).
--
-- 006 kept the bytes in a `bytea` column, with the note that they should move to
-- object storage if uploads ever outgrew it. They have: a 1 GB quota per user
-- times a site-wide user base is not something to keep in pg_dump, every read
-- copied the whole image through Node, and there was no way to spread the load
-- over more than one machine. SeaweedFS gives all three -- volume servers scale
-- horizontally (`--scale seaweed-volume=N`) and rebalance themselves.
--
-- This table stays the index and the authority on ownership and quota; only the
-- payload leaves. `object_key` is the S3 key inside S3_BUCKET.
--
-- The bytes cannot be moved by a SQL statement, so any pre-existing rows would
-- point at objects that were never written. The DELETE below drops them; at the
-- time of writing the table is empty (this feature has only ever run in dev), so
-- it is a no-op. Anything it did remove would be an image in an old message,
-- which would render as a broken thumbnail -- not a data-loss event worth a
-- migration tool.

DELETE FROM attachments;

ALTER TABLE attachments DROP COLUMN data;
ALTER TABLE attachments ADD COLUMN object_key text NOT NULL;

-- bytes was `integer`, which caps a single file at 2 GB. The quota is already
-- 1 GB and configurable upwards, so widen it before it becomes a bug.
ALTER TABLE attachments ALTER COLUMN bytes TYPE bigint;

-- One row per object: prevents two attachments from sharing (and racing to
-- delete) the same key.
CREATE UNIQUE INDEX attachments_object_key ON attachments (object_key);
