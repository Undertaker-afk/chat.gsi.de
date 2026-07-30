-- Cache of external documents fetched on a user's behalf (currently the PDFs
-- linked from answers, served by /api/pdf).
--
-- Bytes go to object storage like everything else; this table is the index and
-- the freshness oracle. A separate table rather than a flag on attachments or
-- generated_files because these belong to nobody: they are a copy of a public
-- www.gsi.de document, shared by every user who opens the same link, and they
-- must NOT count against anyone's quota.
--
-- Keyed by a hash of the URL rather than the URL itself: the URL is the natural
-- key but can exceed the length Postgres will index in a btree, and the hash is
-- also what the object key uses.
CREATE TABLE external_cache (
    url_hash    text PRIMARY KEY,
    url         text NOT NULL,
    mime        text NOT NULL,
    bytes       integer NOT NULL CHECK (bytes > 0),
    object_key  text NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- Drives the sweep of entries past their TTL.
CREATE INDEX external_cache_fetched ON external_cache (fetched_at);
