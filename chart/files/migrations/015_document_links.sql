-- Every URL the corpus links to, as an allowlist for the PDF proxy.
--
-- The proxy used to allow only hosts at or under gsi.de. That is the crawler's
-- boundary and it is right for the crawler, but it is the wrong boundary for
-- *reading a citation*: GSI pages link their own papers on accelconf.web.cern.ch,
-- proceedings.jacow.org, epics-controls.org and a dozen university hosts, and
-- every one of those came back 403 "nur PDFs auf gsi.de" when the user clicked it.
--
-- Widening to "any URL" would turn the proxy into an open relay. Widening to
-- "any URL our own crawler already ingested from a gsi.de page" keeps it closed:
-- the allowlist is data the crawler produced, not anything a caller can inject.
--
-- Maintained by trigger rather than by the crawler, so it stays correct without
-- a crawler release and cannot drift if a document is written by any other path.

CREATE TABLE IF NOT EXISTS document_links (
    document_id bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    url         text   NOT NULL,
    PRIMARY KEY (document_id, url)
);

-- Lookups are exact-match on a lowercased URL. Host case is meaningless and the
-- corpus genuinely contains both `SRVIIS02.gsi.de` and `.PDF`, so comparing
-- case-insensitively costs nothing: it can only match URLs already in the corpus.
CREATE INDEX IF NOT EXISTS document_links_url ON document_links (lower(url));

/*
 * Pull http(s) URLs out of a document body.
 *
 * The character class stops at whitespace and at the delimiters markdown puts
 * around a link -- `)` closes `[text](url)`, `>` closes `<url>` -- and trailing
 * sentence punctuation is trimmed afterwards so "see https://x/y.pdf." does not
 * store a URL ending in a full stop.
 */
CREATE OR REPLACE FUNCTION extract_document_links(md text)
RETURNS SETOF text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT DISTINCT trimmed
      FROM (
        SELECT regexp_replace(m[1], '[.,;:!?''"]+$', '') AS trimmed
          FROM regexp_matches(md, '(https?://[^\s)"''<>\]]+)', 'gi') AS m
      ) t
     WHERE length(trimmed) BETWEEN 12 AND 2048;
$$;

CREATE OR REPLACE FUNCTION document_links_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM document_links WHERE document_id = NEW.id;
    INSERT INTO document_links (document_id, url)
    SELECT NEW.id, u FROM extract_document_links(NEW.markdown) AS u
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_links_sync ON documents;
CREATE TRIGGER documents_links_sync
    AFTER INSERT OR UPDATE OF markdown ON documents
    FOR EACH ROW EXECUTE FUNCTION document_links_sync();

-- Backfill what is already crawled. Idempotent, so re-running the migration is
-- safe.
INSERT INTO document_links (document_id, url)
SELECT d.id, u
  FROM documents d, extract_document_links(d.markdown) AS u
ON CONFLICT DO NOTHING;
