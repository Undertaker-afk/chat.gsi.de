import postgres from 'postgres';
import { config } from './config';
import { deleteObject } from './s3';
import { metrics } from './metrics';

/**
 * Lazily-connected Postgres client.
 *
 * Connecting at module load would break `vite build`: SvelteKit's build analysis
 * imports server modules with no DATABASE_URL present. The proxy defers the
 * connection to first use while keeping both call styles working --
 * sql`SELECT ...` as a tagged template, and helpers like sql.json().
 */
let pool: ReturnType<typeof postgres> | null = null;

function client(): ReturnType<typeof postgres> {
	return (pool ??= postgres(config.db.url, {
		max: 10,
		idle_timeout: 30,
		transform: { undefined: null }
	}));
}

/**
 * Timing wrapper around a postgres.js Query.
 *
 * The subtlety that dictates the shape of this: sql`...` does NOT always mean
 * "run a query". It is also how fragments are built --
 * `const kbFilter = sql\`AND d.kb_id = ANY(${ids})\`` in retrieval.ts is
 * interpolated into a larger statement and must never execute on its own. A
 * Query is a lazy thenable, so the fragment case is exactly the case where
 * nobody ever awaits it.
 *
 * So the timer hangs off `then` and nothing else. Awaiting is what executes a
 * query, which makes it also the only honest place to start a clock: a fragment
 * is never awaited, is never counted, and -- critically -- is never forced to
 * run by the instrumentation itself. Everything other than `then` is forwarded
 * untouched, so postgres.js's internal inspection of the object still sees the
 * real Query.
 */
function timed<T extends object>(query: T): T {
	return new Proxy(query, {
		get(target, prop) {
			// receiver is the target, not the proxy: postgres.js reads its own
			// internals off `this`, and handing it the proxy would make every one of
			// those reads re-enter this trap for no reason.
			const value = Reflect.get(target, prop, target);
			if (prop !== 'then' || typeof value !== 'function') return value;
			return (onFulfilled?: unknown, onRejected?: unknown) => {
				const started = process.hrtime.bigint();
				const done = (outcome: string) => {
					metrics.dbQueries.inc({ outcome });
					metrics.dbDuration.observe({}, Number(process.hrtime.bigint() - started) / 1e9);
				};
				return (value as (...a: unknown[]) => unknown).call(
					target,
					(result: unknown) => {
						done('ok');
						return typeof onFulfilled === 'function' ? onFulfilled(result) : result;
					},
					(err: unknown) => {
						done('error');
						if (typeof onRejected === 'function') return onRejected(err);
						throw err;
					}
				);
			};
		}
	});
}

export const sql = new Proxy((() => {}) as unknown as ReturnType<typeof postgres>, {
	apply: (_target, _thisArg, args: unknown[]) => {
		const result = (client() as unknown as (...a: unknown[]) => unknown)(...args);
		// Every form of sql(...) comes back thenable -- the tagged template, a
		// fragment, and the sql(rows, ...columns) helper that builds an INSERT
		// body. So this check is a guard, not a filter, and the wrapper has to be
		// inert rather than selective: it is applied to all of them and only does
		// anything once something is actually awaited. Verified against the live
		// database: an interpolated fragment still executes as part of its parent
		// statement and is never counted as a query of its own.
		return result && typeof (result as { then?: unknown }).then === 'function'
			? timed(result as object)
			: result;
	},
	get: (_target, prop) => (client() as unknown as Record<string | symbol, unknown>)[prop]
});

export interface Conversation {
	id: string;
	user_sub: string;
	title: string | null;
	mode: 'fast' | 'deep';
	active_leaf_id: string | null;
	created_at: Date;
	updated_at: Date;
}

export async function listConversations(userSub: string): Promise<Conversation[]> {
	// Conversations hidden by a revocation are excluded here and in
	// getConversation, so a lost knowledge base takes its history out of reach
	// through every door at once (plan.md §8b).
	return sql<Conversation[]>`
		SELECT * FROM conversations
		 WHERE user_sub = ${userSub}
		   AND id NOT IN (SELECT conversation_id FROM hidden_conversations)
		ORDER BY updated_at DESC LIMIT 100`;
}

/** Always scoped by user_sub, never by id alone -- conversation ids are
 *  guessable enough that an id-only lookup would be an access-control hole. */
export async function getConversation(id: string, userSub: string): Promise<Conversation | null> {
	const [row] = await sql<Conversation[]>`
		SELECT * FROM conversations
		 WHERE id = ${id} AND user_sub = ${userSub}
		   AND id NOT IN (SELECT conversation_id FROM hidden_conversations)`;
	return row ?? null;
}

export async function createConversation(
	userSub: string,
	mode: 'fast' | 'deep',
	title: string | null
): Promise<string> {
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO conversations (user_sub, mode, title)
		VALUES (${userSub}, ${mode}, ${title ? title.slice(0, 120) : null})
		RETURNING id`;
	return row.id;
}

export async function renameConversation(id: string, userSub: string, title: string) {
	await sql`
		UPDATE conversations SET title = ${title.slice(0, 120)}
		 WHERE id = ${id} AND user_sub = ${userSub}`;
}

/**
 * Delete a conversation and everything stored for it.
 *
 * Rows go through ON DELETE CASCADE (messages -> attachments, generated_files),
 * but a database cascade cannot reach object storage. So the object keys are
 * collected first and the objects removed after the row delete succeeds --
 * that order leaves an orphaned object on failure rather than a row pointing at
 * bytes that are already gone.
 */
export async function deleteConversation(id: string, userSub: string) {
	// Attachments only. Generated files deliberately survive -- see migration 016:
	// the user saved them on purpose, and deleting a chat must not quietly take a
	// script with it. Their rows stay, with message_id set to NULL by the FK.
	const objects = await sql<{ object_key: string }[]>`
		SELECT a.object_key
		  FROM messages m
		  JOIN attachments a ON a.message_id = m.id
		  JOIN conversations c ON c.id = m.conversation_id
		 WHERE m.conversation_id = ${id} AND c.user_sub = ${userSub}`;

	await sql`DELETE FROM conversations WHERE id = ${id} AND user_sub = ${userSub}`;

	// Best effort: a failed object delete must not fail the user's delete, which
	// has already happened as far as the database is concerned.
	await Promise.all(objects.map((o) => deleteObject(o.object_key).catch(() => {})));
}

export async function addMessage(opts: {
	conversationId: string;
	role: 'user' | 'assistant';
	content: string;
	images?: string[] | null;
	trace?: Record<string, unknown> | null;
	/** null for the first message in a conversation; see 005_message_tree.sql. */
	parentId?: string | null;
}): Promise<string> {
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO messages (conversation_id, role, content, images, trace, parent_id)
		VALUES (${opts.conversationId}, ${opts.role}, ${opts.content},
		        ${opts.images ? sql.json(opts.images) : null},
		        ${opts.trace ? sql.json(opts.trace as never) : null},
		        ${opts.parentId ?? null})
		RETURNING id`;
	await sql`UPDATE conversations SET updated_at = now() WHERE id = ${opts.conversationId}`;
	return row.id;
}

export async function setActiveLeaf(conversationId: string, messageId: string) {
	await sql`
		UPDATE conversations SET active_leaf_id = ${messageId} WHERE id = ${conversationId}`;
}

export async function addCitations(
	messageId: string,
	citations: { marker: number; chunkId: number; score: number }[]
): Promise<void> {
	if (citations.length === 0) return;
	await sql`
		INSERT INTO citations ${sql(
			citations.map((c) => ({
				message_id: messageId,
				chunk_id: c.chunkId,
				marker: c.marker,
				score: c.score
			}))
		)}
		ON CONFLICT DO NOTHING`;
}
