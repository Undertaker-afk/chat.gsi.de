-- Generated files now die with the conversation that produced them.
--
-- 012 used ON DELETE SET NULL on the theory that a file the user deliberately
-- saved should outlive its chat. That is not the wanted behaviour: deleting a
-- conversation is how a user removes what was discussed, and a script generated
-- inside it is part of that. Leaving the file behind means "delete this chat"
-- silently keeps a copy.
--
-- The object in S3 is removed by deleteConversation(), which reads the keys
-- before issuing the DELETE -- a database CASCADE cannot reach object storage.
ALTER TABLE generated_files
    DROP CONSTRAINT generated_files_message_id_fkey;

ALTER TABLE generated_files
    ADD CONSTRAINT generated_files_message_id_fkey
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
