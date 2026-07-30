-- 009: derive knowledge bases for the wiki corpus and attach every document.
--
-- A Foswiki URL's first path segment IS its web (https://wiki.gsi.de/Linux/WebHome
-- -> "Linux"), so the existing corpus can be classified without a re-crawl. New
-- documents get kb_id from the crawler; this only closes the gap for what is
-- already indexed, and is written to be safe to run again.

-- One knowledge base per web actually present in the corpus.
INSERT INTO knowledge_bases (source_id, web, slug, label, is_default)
SELECT DISTINCT
       d.source_id,
       split_part(regexp_replace(d.url, '^https?://[^/]+/', ''), '/', 1) AS web,
       s.slug || ':' || split_part(regexp_replace(d.url, '^https?://[^/]+/', ''), '/', 1),
       split_part(regexp_replace(d.url, '^https?://[^/]+/', ''), '/', 1),
       -- Main is Foswiki's front web and carries the general staff pages: the
       -- sensible half of the public baseline. Everything else starts private.
       split_part(regexp_replace(d.url, '^https?://[^/]+/', ''), '/', 1) = 'Main'
  FROM documents d
  JOIN sources s ON s.id = d.source_id
 WHERE s.connector = 'foswiki'
   AND split_part(regexp_replace(d.url, '^https?://[^/]+/', ''), '/', 1) <> ''
ON CONFLICT DO NOTHING;

-- Wiki documents -> their web's knowledge base.
UPDATE documents d
   SET kb_id = kb.id
  FROM sources s, knowledge_bases kb
 WHERE s.id = d.source_id
   AND s.connector = 'foswiki'
   AND kb.source_id = d.source_id
   AND kb.web = split_part(regexp_replace(d.url, '^https?://[^/]+/', ''), '/', 1)
   AND d.kb_id IS DISTINCT FROM kb.id;

-- Everything else -> its source's single knowledge base.
UPDATE documents d
   SET kb_id = kb.id
  FROM sources s, knowledge_bases kb
 WHERE s.id = d.source_id
   AND s.connector <> 'foswiki'
   AND kb.source_id = d.source_id
   AND kb.web IS NULL
   AND d.kb_id IS DISTINCT FROM kb.id;
