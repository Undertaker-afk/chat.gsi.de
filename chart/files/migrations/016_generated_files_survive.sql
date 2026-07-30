-- Generated files outlive the conversation that produced them. Reverts 013.
--
-- 013 made them CASCADE on the argument that deleting a chat is how a user
-- removes what was discussed. That argument is wrong, and the counter-argument
-- is simpler: saving a file is a separate, deliberate act. Every generated file
-- exists because somebody opened the save dialog, chose a name and confirmed it.
-- Nobody does that for something they expect to be swept away later.
--
-- The failure mode also matters. Deleting a chat is routine tidying; losing a
-- Slurm script you had kept is not recoverable, and nothing in the delete
-- confirmation warns that it is about to happen. Keeping the file has a cheap
-- failure mode -- an unwanted file, deletable in one click from /files.
--
-- After this, deleting a conversation sets message_id to NULL. The file stays
-- in the list and stays downloadable; it only loses its link back to the chat,
-- which is exactly what has gone away. It also stops being editable by the
-- assistant, since that is scoped by conversation (see listGeneratedInConversation).

ALTER TABLE generated_files
    DROP CONSTRAINT generated_files_message_id_fkey;

ALTER TABLE generated_files
    ADD CONSTRAINT generated_files_message_id_fkey
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;
