-- 002: core schema. See plan.md §4.

CREATE TABLE sources (
    id            bigserial PRIMARY KEY,
    slug          text UNIQUE NOT NULL,
    base_url      text NOT NULL,
    connector     text NOT NULL,
    config        jsonb NOT NULL DEFAULT '{}',
    enabled       boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crawl_runs (
    id            bigserial PRIMARY KEY,
    source_id     bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','ok','failed','partial')),
    pages_seen    int NOT NULL DEFAULT 0,
    pages_changed int NOT NULL DEFAULT 0,
    pages_deleted int NOT NULL DEFAULT 0,
    error         text
);
CREATE INDEX crawl_runs_source ON crawl_runs (source_id, started_at DESC);

CREATE TABLE documents (
    id            bigserial PRIMARY KEY,
    source_id     bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url           text NOT NULL,
    title         text NOT NULL,
    content_hash  text NOT NULL,
    markdown      text NOT NULL,
    frontmatter   jsonb NOT NULL DEFAULT '{}',
    lang          text,
    last_seen_run bigint REFERENCES crawl_runs(id) ON DELETE SET NULL,
    fetched_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,
    UNIQUE (source_id, url)
);
CREATE INDEX documents_live ON documents (source_id) WHERE deleted_at IS NULL;

CREATE TABLE chunks (
    id            bigserial PRIMARY KEY,
    document_id   bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal       int NOT NULL,
    heading_path  text[] NOT NULL DEFAULT '{}',
    anchor        text,
    text          text NOT NULL,
    token_count   int NOT NULL,
    embedding     vector(4096),   -- Qwen3-Embedding-8B; dimension verified against the proxy
    tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
    UNIQUE (document_id, ordinal)
);

CREATE TABLE conversations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub      text NOT NULL,
    title         text,
    mode          text NOT NULL DEFAULT 'fast' CHECK (mode IN ('fast','deep')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user ON conversations (user_sub, updated_at DESC);

CREATE TABLE messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            text NOT NULL CHECK (role IN ('user','assistant','system')),
    content         text NOT NULL,
    images          jsonb,
    trace           jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON messages (conversation_id, created_at);

CREATE TABLE citations (
    message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chunk_id      bigint NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    marker        int NOT NULL,
    score         real,
    PRIMARY KEY (message_id, marker)
);

CREATE TABLE feedback (
    message_id    uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    user_sub      text NOT NULL,
    rating        smallint NOT NULL CHECK (rating IN (-1, 1)),
    comment       text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
