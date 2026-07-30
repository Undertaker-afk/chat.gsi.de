-- 008: knowledge bases and delegated access control (plan.md §8b).
--
-- Two levels of authority. An admin decides what a department may reach AT MOST
-- (group_grants, the ceiling); the department's own manager decides who inside it
-- gets how much of that (member_grants, always a subset). Nobody can widen their
-- own reach, which is the whole point of splitting the two.
--
-- Keycloak stays read-only to us: it authenticates and issues roles, and a
-- service account with view-users answers "who exists". Everything below lives
-- here, next to the data it protects.

-- --------------------------------------------------------------------------
-- Knowledge bases: what a grant points at.
-- --------------------------------------------------------------------------
-- One row per Foswiki web (wiki.gsi.de has ~28) plus one per non-wiki source.
-- Per-web granularity is the reason this feature exists: "access to the wiki"
-- would be no control at all.
CREATE TABLE knowledge_bases (
    id          bigserial PRIMARY KEY,
    source_id   bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    -- NULL for sources that are one knowledge base as a whole (virgo-docs, www).
    web         text,
    slug        text UNIQUE NOT NULL,          -- 'wiki:Linux', 'virgo-docs'
    label       text NOT NULL,                 -- shown in the UIs
    -- The public baseline: granted to every llmbot-user without any group, so a
    -- new account is useful before anyone provisions it.
    is_default  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX knowledge_bases_source_web
    ON knowledge_bases (source_id, coalesce(web, ''));

-- Documents carry their knowledge base so retrieval can filter with a plain
-- indexed equality instead of parsing URLs at query time.
ALTER TABLE documents ADD COLUMN kb_id bigint REFERENCES knowledge_bases(id) ON DELETE SET NULL;
CREATE INDEX documents_kb ON documents (kb_id) WHERE deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- Users, groups, membership.
-- --------------------------------------------------------------------------
-- A local mirror, not an authority: it exists so the admin UI can show a name
-- next to a sub, and so grants survive a user being renamed upstream. Rows are
-- written on login and refreshed from the Keycloak directory listing.
CREATE TABLE app_users (
    sub           text PRIMARY KEY,
    username      text,
    name          text,
    email         text,
    -- Cached from the token at login; display only, never used for access checks
    -- (those always read the live token).
    roles         text[] NOT NULL DEFAULT '{}',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groups (
    id          bigserial PRIMARY KEY,
    name        text UNIQUE NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  text
);

CREATE TABLE group_members (
    group_id   bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_sub   text NOT NULL,
    -- Managers hold llmbot-privileged and administer THIS group's members. The
    -- role alone grants nothing: it only becomes power together with a row here.
    is_manager boolean NOT NULL DEFAULT false,
    -- false: the member inherits the group's full ceiling.
    -- true:  the member gets exactly member_grants, which may be empty.
    -- Without this flag "no rows" would be ambiguous, and a manager unticking
    -- their last knowledge base would silently restore full access.
    restricted boolean NOT NULL DEFAULT false,
    added_at   timestamptz NOT NULL DEFAULT now(),
    added_by   text,
    PRIMARY KEY (group_id, user_sub)
);
CREATE INDEX group_members_user ON group_members (user_sub);

-- The ceiling. Admin-only.
CREATE TABLE group_grants (
    group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    kb_id    bigint NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, kb_id)
);

-- The manager's subset. The composite foreign key means removing someone from a
-- group takes their per-member grants with them, and the application refuses any
-- kb_id that is not in the group's ceiling.
CREATE TABLE member_grants (
    group_id bigint NOT NULL,
    user_sub text NOT NULL,
    kb_id    bigint NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_sub, kb_id),
    FOREIGN KEY (group_id, user_sub) REFERENCES group_members (group_id, user_sub) ON DELETE CASCADE
);

-- --------------------------------------------------------------------------
-- Audit.
-- --------------------------------------------------------------------------
-- One insert per privileged change. The first thing anyone asks after an
-- incident is "who gave them access?", and without this the answer is a shrug.
CREATE TABLE audit_log (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    actor_sub  text NOT NULL,
    actor_name text,
    action     text NOT NULL,     -- 'group.create', 'grant.set', 'member.add', 'crawl.trigger', …
    target     text,              -- human-readable subject of the action
    detail     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_recent ON audit_log (at DESC);
CREATE INDEX audit_log_actor  ON audit_log (actor_sub, at DESC);

-- --------------------------------------------------------------------------
-- Revocation.
-- --------------------------------------------------------------------------
-- A conversation that cites a knowledge base the owner has lost is hidden at
-- once and purged after the grace period. Hiding is a row rather than a delete
-- so a mistaken revocation stays repairable until the purge runs; the purge is
-- what actually bounds how long revoked material sits in the database.
CREATE TABLE hidden_conversations (
    conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    hidden_at       timestamptz NOT NULL DEFAULT now(),
    -- The knowledge bases that caused it, so re-granting any of them can lift
    -- the hiding without a full recheck.
    kb_ids          bigint[] NOT NULL DEFAULT '{}'
);

-- --------------------------------------------------------------------------
-- Seed: one knowledge base per existing non-wiki source.
-- --------------------------------------------------------------------------
-- Wiki webs are created by the backfill in 009, since they are discovered from
-- the corpus rather than declared.
INSERT INTO knowledge_bases (source_id, web, slug, label, is_default)
SELECT id, NULL, slug, slug, slug = 'www'
  FROM sources
 WHERE connector <> 'foswiki'
ON CONFLICT DO NOTHING;
