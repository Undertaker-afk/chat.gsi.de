-- 006: user uploads.
--
-- Images were previously inlined into messages.images as base64 data URLs. That
-- works but is a poor store: base64 costs ~33% overhead, the bytes are duplicated
-- into every conversation payload, and there is no way to tell a user how much
-- space they are using or to let them delete anything. Uploads now live here and
-- messages reference them by URL.
--
-- Bytes are held in the database rather than on disk deliberately: it keeps the
-- backup story to a single pg_dump, and the quota (1 GB/user by default) bounds
-- the growth. If uploads ever grow past that, move `data` to object storage and
-- keep this table as the index.

CREATE TABLE attachments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub    text NOT NULL,
    -- NULL until the upload is actually sent with a message. Orphans are
    -- reclaimable (the user can delete them, and they still count against quota
    -- so an abandoned upload cannot be used to hide storage).
    message_id  uuid REFERENCES messages(id) ON DELETE CASCADE,
    filename    text,
    mime        text NOT NULL,
    bytes       integer NOT NULL CHECK (bytes > 0),
    data        bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_user    ON attachments (user_sub, created_at DESC);
CREATE INDEX attachments_message ON attachments (message_id);
