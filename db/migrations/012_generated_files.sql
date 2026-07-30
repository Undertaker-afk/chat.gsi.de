-- Files the assistant produced and the user chose to keep (plan.md: Generated
-- files).
--
-- Deliberately a separate table from `attachments` rather than a flag on it:
--   * attachments are INPUT (what the user sent up, image-only, tied to the
--     message they were sent with), generated files are OUTPUT (what the model
--     wrote, any text type, saved after the fact);
--   * deleting a conversation must not delete files the user deliberately kept,
--     so message_id is ON DELETE SET NULL here where attachments CASCADE;
--   * the viewer needs `language` to pick a Monaco mode, which has no meaning
--     for an upload.
--
-- Bytes live in object storage like attachments do (007); this table is the
-- index. Both count against the same per-user quota -- see storage.usage().
CREATE TABLE generated_files (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub    text NOT NULL,
    -- Which answer produced it. NULL once that conversation is gone; the file
    -- itself survives, because the user asked to keep it.
    message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
    filename    text NOT NULL,
    mime        text NOT NULL,
    -- Fence info string from the answer ("bash", "python", "sql"), used to pick
    -- the Monaco language. NULL when it could not be determined.
    language    text,
    bytes       integer NOT NULL CHECK (bytes > 0),
    object_key  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX generated_files_user ON generated_files (user_sub, created_at DESC);
CREATE INDEX generated_files_message ON generated_files (message_id);

-- One name per user. Saving the same filename twice overwrites deliberately
-- (the UI offers a rename), rather than silently accumulating "script (3).sh".
CREATE UNIQUE INDEX generated_files_user_name ON generated_files (user_sub, filename);
