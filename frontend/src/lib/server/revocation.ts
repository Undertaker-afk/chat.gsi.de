/**
 * What happens to old conversations when access is taken away (plan.md §8b).
 *
 * A conversation that cites a knowledge base its owner has lost is hidden at
 * once -- gone from the sidebar, 404 on its URL -- and purged with its
 * attachments after the grace period. Hiding is a row rather than a delete so a
 * mistaken revocation stays repairable; the purge is what actually bounds how
 * long revoked material sits in the database.
 *
 * The sweep is deliberately cheap and idempotent: it recomputes from scratch, so
 * it can be run after any permission change without tracking what changed.
 */
import { sql } from './db';
import { config } from './config';

/**
 * Re-evaluate every affected user's conversations.
 *
 * Pass the users whose access just changed; omit for a full sweep (used by the
 * purge job, and cheap enough at this scale to be the safe default).
 */
export async function sweep(userSubs?: string[]): Promise<{ hidden: number; unhidden: number }> {
	const scoped = userSubs && userSubs.length > 0;

	// Hide: conversations citing a knowledge base the owner can no longer reach.
	// `effective` mirrors permissions.effectiveKbIds -- kept as SQL here so the
	// whole sweep is one statement rather than a query per user.
	const hidden = await sql<{ id: string }[]>`
		WITH effective AS (
			SELECT c.user_sub, kb.id AS kb_id
			  FROM (SELECT DISTINCT user_sub FROM conversations
			         ${scoped ? sql`WHERE user_sub = ANY(${userSubs!})` : sql``}) c
			  JOIN knowledge_bases kb ON kb.is_default
			UNION
			SELECT gm.user_sub, gg.kb_id
			  FROM group_members gm
			  JOIN group_grants gg ON gg.group_id = gm.group_id
			 WHERE NOT gm.restricted
			UNION
			SELECT gm.user_sub, mg.kb_id
			  FROM group_members gm
			  JOIN member_grants mg ON mg.group_id = gm.group_id AND mg.user_sub = gm.user_sub
			  JOIN group_grants gg ON gg.group_id = gm.group_id AND gg.kb_id = mg.kb_id
			 WHERE gm.restricted
		),
		cited AS (
			SELECT c.id, c.user_sub, array_agg(DISTINCT d.kb_id) AS kb_ids
			  FROM conversations c
			  JOIN messages m ON m.conversation_id = c.id
			  JOIN citations ct ON ct.message_id = m.id
			  JOIN chunks ch ON ch.id = ct.chunk_id
			  JOIN documents d ON d.id = ch.document_id
			 WHERE d.kb_id IS NOT NULL
			   ${scoped ? sql`AND c.user_sub = ANY(${userSubs!})` : sql``}
			 GROUP BY c.id, c.user_sub
		),
		offending AS (
			SELECT cited.id, cited.user_sub,
			       array_agg(kb) AS lost
			  FROM cited, unnest(cited.kb_ids) AS kb
			 WHERE NOT EXISTS (
			       SELECT 1 FROM effective e
			        WHERE e.user_sub = cited.user_sub AND e.kb_id = kb)
			 GROUP BY cited.id, cited.user_sub
		)
		INSERT INTO hidden_conversations (conversation_id, kb_ids)
		SELECT id, lost FROM offending
		ON CONFLICT (conversation_id) DO UPDATE SET kb_ids = EXCLUDED.kb_ids
		RETURNING conversation_id AS id`;

	// Unhide: access came back before the purge ran.
	const unhidden = await sql<{ id: string }[]>`
		DELETE FROM hidden_conversations h
		 USING conversations c
		 WHERE c.id = h.conversation_id
		   ${scoped ? sql`AND c.user_sub = ANY(${userSubs!})` : sql``}
		   AND NOT EXISTS (
			   SELECT 1 FROM messages m
			     JOIN citations ct ON ct.message_id = m.id
			     JOIN chunks ch ON ch.id = ct.chunk_id
			     JOIN documents d ON d.id = ch.document_id
			    WHERE m.conversation_id = c.id
			      AND d.kb_id IS NOT NULL
			      AND NOT EXISTS (
				      SELECT 1 FROM knowledge_bases kb WHERE kb.id = d.kb_id AND kb.is_default
				      UNION
				      SELECT 1 FROM group_members gm
				        JOIN group_grants gg ON gg.group_id = gm.group_id
				       WHERE gm.user_sub = c.user_sub AND NOT gm.restricted AND gg.kb_id = d.kb_id
				      UNION
				      SELECT 1 FROM group_members gm
				        JOIN member_grants mg
				          ON mg.group_id = gm.group_id AND mg.user_sub = gm.user_sub
				        JOIN group_grants gg
				          ON gg.group_id = gm.group_id AND gg.kb_id = mg.kb_id
				       WHERE gm.user_sub = c.user_sub AND gm.restricted AND mg.kb_id = d.kb_id))
		RETURNING h.conversation_id AS id`;

	return { hidden: hidden.length, unhidden: unhidden.length };
}

/**
 * Delete what has been hidden longer than the grace period.
 *
 * Attachments go with the conversation through the existing ON DELETE CASCADE;
 * their objects are removed by the caller, which has the S3 client.
 */
export async function purgeExpired(): Promise<{ conversations: string[]; objectKeys: string[] }> {
	const days = config.access.revocationGraceDays;

	const objects = await sql<{ object_key: string }[]>`
		SELECT a.object_key
		  FROM hidden_conversations h
		  JOIN messages m ON m.conversation_id = h.conversation_id
		  JOIN attachments a ON a.message_id = m.id
		 WHERE h.hidden_at < now() - ${days} * interval '1 day'`;

	const gone = await sql<{ id: string }[]>`
		DELETE FROM conversations c
		 USING hidden_conversations h
		 WHERE h.conversation_id = c.id
		   AND h.hidden_at < now() - ${days} * interval '1 day'
		RETURNING c.id`;

	return { conversations: gone.map((r) => r.id), objectKeys: objects.map((r) => r.object_key) };
}

/** Conversation ids currently hidden from this user. */
export async function hiddenFor(userSub: string): Promise<string[]> {
	const rows = await sql<{ conversation_id: string }[]>`
		SELECT h.conversation_id FROM hidden_conversations h
		  JOIN conversations c ON c.id = h.conversation_id
		 WHERE c.user_sub = ${userSub}`;
	return rows.map((r) => r.conversation_id);
}
