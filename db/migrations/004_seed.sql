-- 004: seed sources.
--
-- wiki.gsi.de runs Foswiki (confirmed 2026-07-27) -- the "FOSS Wiki" of the design
-- sketch. It publishes no sitemap, and WebIndex/WebRss are login-gated for guests,
-- so discovery is a link crawl seeded from each web's WebHome. See
-- crawler/app/connectors/foswiki.py for the full reasoning.
--
-- The crawler runs ANONYMOUSLY and must stay that way: restricted webs are hidden
-- from the anonymous web list and serve a login page instead of content, which is
-- what keeps restricted material out of the index (plan.md §12).

INSERT INTO sources (slug, base_url, connector, config, enabled) VALUES
  ('wiki', 'https://wiki.gsi.de/', 'foswiki', jsonb_build_object(
      -- robots.txt: Crawl-delay: 5. Enforced in the connector regardless of
      -- CRAWL_RATE_LIMIT_RPS, so a misconfiguration cannot hammer the wiki.
      'crawl_delay_s', 5,
      -- Foswiki's own manual, not GSI content.
      'exclude_webs', jsonb_build_array('System', 'Sandbox', 'Trash', 'TWiki'),
      -- Leave 'webs' null to auto-discover the public web list from Main/WebHome.
      -- Set it to pin the crawl to specific webs, e.g. for a first trial run:
      --   'webs', jsonb_build_array('Linux', 'Main')
      'max_pages', 20000
  ), true),

  -- Phase 6. Disabled until the wiki pipeline is proven.
  ('virgo-docs', 'https://virgo-docs.hpc.gsi.de/', 'html', jsonb_build_object(
      'sitemap', '/sitemap.xml',
      'include', jsonb_build_array('/user-guide/**')
  ), false),

  ('www', 'https://www.gsi.de/', 'html', jsonb_build_object(
      'sitemap', '/sitemap.xml'
  ), false)
ON CONFLICT (slug) DO NOTHING;
