-- 022: let the www crawl follow links as well as the sitemap.
--
-- www.gsi.de's sitemap is an index of three nested sitemaps holding 2040 URLs
-- in total, all of them TYPO3 *page* records (`?sitemap=pages`). News, press and
-- other record-backed URLs are reachable by following links but appear nowhere
-- in it, so a sitemap-only crawl of this source stops at 2040 pages however much
-- the site actually publishes -- measured, not assumed: the crawler logged
-- "www: 2040 urls from sitemap" while earlier setups had indexed 4000+.
--
-- `discovery: both` unions the sitemap with a link crawl and deduplicates
-- (crawler/app/connectors/html_sitemap.py). The sitemap still gives fast,
-- complete coverage of page records; the link crawl finds the rest.
--
-- The cost is a second pass: the link crawl fetches pages to read their links,
-- and the pipeline fetches again to index them. Bounded by the connector's
-- max_pages (10000) and by the existing host-scope and include/exclude guards,
-- so it cannot wander off-site.
--
-- Only sets the key when it is absent, so a source someone has already tuned
-- keeps whatever it was given.

UPDATE sources
   SET config = jsonb_set(config::jsonb, '{discovery}', '"both"'::jsonb)::json
 WHERE slug = 'www'
   AND config::jsonb -> 'discovery' IS NULL;
