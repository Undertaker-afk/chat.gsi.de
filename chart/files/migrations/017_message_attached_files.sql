-- Which generated files a user attached to a question.
--
-- `generated_files.message_id` already exists but means the opposite thing: the
-- assistant message that PRODUCED the file. Reusing it for attachment would
-- overwrite that link and silently break the edit scoping, which resolves a
-- file to its conversation through exactly that column.
--
-- Without this table an attached file left no trace at all: the server read its
-- contents for the model and the transcript showed a bare question, so a user
-- who attached a script could not see afterwards what they had sent.
--
-- Many-to-many because one question can carry several files, and one file can
-- be attached to any number of questions over its life.

CREATE TABLE IF NOT EXISTS message_attached_files (
    message_id        uuid NOT NULL REFERENCES messages(id)        ON DELETE CASCADE,
    generated_file_id uuid NOT NULL REFERENCES generated_files(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, generated_file_id)
);

-- The only read pattern: every attachment for the messages on screen.
CREATE INDEX IF NOT EXISTS message_attached_files_message
    ON message_attached_files (message_id);

-- Both sides CASCADE, and both are right:
--   * deleting a message drops the link, not the file -- the file outlives its
--     chat by design (migration 016) and stays in /files;
--   * deleting the file from /files drops the link, so a transcript never shows
--     a chip pointing at bytes that are gone.
