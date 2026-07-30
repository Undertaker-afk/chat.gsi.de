-- 019: remember the URL DISCOVERY produced, not just the one we stored under.
--
-- These are not always the same, and the difference silently disabled
-- changed-only crawling. virgo-docs is the worked example: the sitemap lists
--   https://hpc.gsi.de/virgo/user-guide/access/index.html
-- which redirects, and because RawPage.url is the post-redirect address the
-- document lands under
--   https://virgo-docs.hpc.gsi.de/user-guide/access/index.html
--
-- The content-hash check never noticed, because it runs AFTER the fetch and so
-- already has the final URL. The revision check runs BEFORE the fetch and only
-- has the discovered one, so every lookup missed and every page was fetched in
-- full. Measured: five consecutive changed-only runs skipped exactly zero pages.
--
-- Nullable, and reads fall back to `url`: existing rows keep working and simply
-- fill this in the next time they are seen.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS discovered_url text;

-- The pre-fetch lookup for changed-only crawls.
CREATE INDEX IF NOT EXISTS documents_discovered_url
    ON documents (source_id, discovered_url)
    WHERE discovered_url IS NOT NULL;
