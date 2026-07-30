-- 005: message branching.
--
-- Editing an earlier message must not destroy the answer it already produced, so
-- messages form a TREE rather than a list. An edit creates a SIBLING of the
-- original (same parent), and the reply to it becomes that sibling's child. The
-- old branch stays intact and reachable, which is what the "< 2/2 >" control in
-- the UI pages through.
--
--   root(user "how do I X?")            <- parent_id IS NULL
--     └ assistant
--        └ user "and Y?"  ── sibling ── user "and Z?"      (an edit)
--             └ assistant                  └ assistant     <- active leaf
--
-- The conversation renders the path from `active_leaf_id` up to the root, so
-- which branch is showing survives a reload.

ALTER TABLE messages
    ADD COLUMN parent_id uuid REFERENCES messages(id) ON DELETE CASCADE;

CREATE INDEX messages_parent ON messages (parent_id, created_at);
-- Roots are looked up per conversation when no active leaf is set yet.
CREATE INDEX messages_roots ON messages (conversation_id, created_at)
    WHERE parent_id IS NULL;

ALTER TABLE conversations
    ADD COLUMN active_leaf_id uuid REFERENCES messages(id) ON DELETE SET NULL;

-- Existing conversations were linear. Chain each message to its predecessor so
-- old history keeps rendering, and point the conversation at its last message.
DO $$
DECLARE
    conv  record;
    msg   record;
    prev  uuid;
BEGIN
    FOR conv IN SELECT id FROM conversations LOOP
        prev := NULL;
        FOR msg IN
            SELECT id FROM messages
             WHERE conversation_id = conv.id
             ORDER BY created_at, id
        LOOP
            UPDATE messages SET parent_id = prev WHERE id = msg.id;
            prev := msg.id;
        END LOOP;
        UPDATE conversations SET active_leaf_id = prev WHERE id = conv.id;
    END LOOP;
END $$;
