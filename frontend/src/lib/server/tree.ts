/**
 * Message-tree navigation (see db/migrations/005_message_tree.sql).
 *
 * Editing an earlier message branches the conversation instead of overwriting it.
 * The rendered conversation is the path from the active leaf up to the root; the
 * "< 2/2 >" control pages through siblings at a given depth.
 */
import { sql } from './db';

export interface PathMessage {
	id: string;
	parent_id: string | null;
	role: 'user' | 'assistant' | 'system';
	content: string;
	images: string[] | null;
	trace: unknown;
	created_at: Date;
	/** 1-based position among its siblings, and how many there are. */
	version: number;
	versions: number;
	/** Sibling ids oldest-first, so the client can jump to prev/next directly. */
	siblingIds: string[];
	citations: { marker: number; url: string; title: string; heading: string }[];
}

interface Row {
	id: string;
	parent_id: string | null;
	role: 'user' | 'assistant' | 'system';
	content: string;
	images: string[] | null;
	trace: unknown;
	created_at: Date;
}

/** Newest child at each step, until a message with no children. */
export async function descendToLeaf(messageId: string): Promise<string> {
	let current = messageId;
	// Bounded: a conversation deeper than this is pathological, and an unbounded
	// loop here would hang the request on a cycle.
	for (let depth = 0; depth < 500; depth++) {
		const [child] = await sql<{ id: string }[]>`
			SELECT id FROM messages WHERE parent_id = ${current}
			 ORDER BY created_at DESC, id DESC LIMIT 1`;
		if (!child) return current;
		current = child.id;
	}
	return current;
}

/** The root of the branch a conversation currently shows. */
async function activeRoot(conversationId: string, activeLeafId: string | null) {
	if (activeLeafId) return activeLeafId;
	const [root] = await sql<{ id: string }[]>`
		SELECT id FROM messages
		 WHERE conversation_id = ${conversationId} AND parent_id IS NULL
		 ORDER BY created_at DESC, id DESC LIMIT 1`;
	return root ? descendToLeaf(root.id) : null;
}

/**
 * The messages to render, root-first, each annotated with its version position.
 */
export async function conversationPath(
	conversationId: string,
	activeLeafId: string | null
): Promise<PathMessage[]> {
	const leaf = await activeRoot(conversationId, activeLeafId);
	if (!leaf) return [];

	// Walk leaf -> root in one query rather than N round-trips.
	const chain = await sql<Row[]>`
		WITH RECURSIVE up AS (
			SELECT id, parent_id, role, content, images, trace, created_at
			  FROM messages WHERE id = ${leaf}
			UNION ALL
			SELECT m.id, m.parent_id, m.role, m.content, m.images, m.trace, m.created_at
			  FROM messages m JOIN up ON m.id = up.parent_id
		)
		SELECT * FROM up`;

	const ordered: Row[] = [];
	const byId = new Map(chain.map((r) => [r.id, r]));
	let cursor: string | null = leaf;
	while (cursor) {
		const row: Row | undefined = byId.get(cursor);
		if (!row) break;
		ordered.unshift(row);
		cursor = row.parent_id;
	}
	if (ordered.length === 0) return [];

	const [siblings, citations] = await Promise.all([
		siblingPositions(conversationId, ordered),
		citationsFor(ordered.map((m) => m.id))
	]);

	return ordered.map((row) => {
		const group = siblings.get(row.parent_id ?? '\u0000root') ?? [row.id];
		return {
			...row,
			version: group.indexOf(row.id) + 1 || 1,
			versions: group.length,
			siblingIds: group,
			citations: citations.get(row.id) ?? []
		};
	});
}

/** Sibling ids grouped by parent, oldest first. Root siblings key on '\0root'. */
async function siblingPositions(conversationId: string, ordered: Row[]) {
	const parents = ordered.map((m) => m.parent_id);
	const realParents = [...new Set(parents.filter((p): p is string => p !== null))];
	const includeRoots = parents.includes(null);

	const rows = await sql<{ id: string; parent_id: string | null }[]>`
		SELECT id, parent_id FROM messages
		 WHERE conversation_id = ${conversationId}
		   AND (parent_id = ANY(${realParents}) ${includeRoots ? sql`OR parent_id IS NULL` : sql``})
		 ORDER BY created_at, id`;

	const grouped = new Map<string, string[]>();
	for (const r of rows) {
		const key = r.parent_id ?? '\u0000root';
		grouped.set(key, [...(grouped.get(key) ?? []), r.id]);
	}
	return grouped;
}

async function citationsFor(messageIds: string[]) {
	if (messageIds.length === 0) return new Map();
	const rows = await sql<
		{ message_id: string; marker: number; url: string; title: string; heading: string }[]
	>`
		SELECT c.message_id, c.marker,
		       d.url || coalesce(ch.anchor, '') AS url,
		       d.title,
		       array_to_string(ch.heading_path, ' › ') AS heading
		  FROM citations c
		  JOIN chunks ch  ON ch.id = c.chunk_id
		  JOIN documents d ON d.id = ch.document_id
		 WHERE c.message_id = ANY(${messageIds})
		 ORDER BY c.marker`;

	const grouped = new Map<string, PathMessage['citations']>();
	for (const r of rows) {
		const list = grouped.get(r.message_id) ?? [];
		list.push({ marker: r.marker, url: r.url, title: r.title, heading: r.heading });
		grouped.set(r.message_id, list);
	}
	return grouped;
}

/**
 * Switch to a sibling branch: select that message and descend to its newest leaf.
 * Returns the new active leaf id.
 */
export async function selectBranch(
	conversationId: string,
	userSub: string,
	messageId: string
): Promise<string | null> {
	const [owned] = await sql<{ id: string }[]>`
		SELECT m.id FROM messages m
		  JOIN conversations c ON c.id = m.conversation_id
		 WHERE m.id = ${messageId} AND m.conversation_id = ${conversationId}
		   AND c.user_sub = ${userSub}`;
	if (!owned) return null;

	const leaf = await descendToLeaf(messageId);
	await sql`UPDATE conversations SET active_leaf_id = ${leaf} WHERE id = ${conversationId}`;
	return leaf;
}
