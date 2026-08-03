-- 021: repair the virgo-docs include pattern.
--
-- 004 seeded  include: ['/user-guide/**']  for a site that publishes its sitemap
-- under a DIFFERENT path prefix than it serves pages from:
--
--   sitemap lists   https://hpc.gsi.de/virgo/user-guide/access/index.html
--   redirects to    https://virgo-docs.hpc.gsi.de/user-guide/access/index.html
--
-- The include filter runs during DISCOVERY, on the first form. The document is
-- stored under the second. So the pattern matched the URL we keep and never the
-- URL we filter, all 52 sitemap entries were rejected before any fetch, and the
-- crawl failed with "discovery returned no pages" on every single run since the
-- source was created. Nothing logged the cause until crawler/app/connectors/
-- html_sitemap.py learned to say which patterns rejected what.
--
-- 004 now seeds both forms, which covers new installs. This repairs the ones
-- already out there.
--
-- Deliberately narrow: it only touches virgo-docs, and only when the include
-- list is still exactly the broken single-entry one. An operator who has since
-- tuned the patterns by hand keeps their version.

UPDATE sources
   SET config = jsonb_set(
           config::jsonb,
           '{include}',
           jsonb_build_array('/virgo/user-guide/**', '/user-guide/**')
       )::json
 WHERE slug = 'virgo-docs'
   AND config::jsonb -> 'include' = jsonb_build_array('/user-guide/**');
