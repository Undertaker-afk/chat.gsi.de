import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { assertAdmin } from '$lib/server/permissions';
import { sql } from '$lib/server/db';

/** The Stats bar: corpus freshness, usage, quality signals, storage. */
export const GET: RequestHandler = async ({ locals }) => {
	assertAdmin(locals.user);

	const [corpus, runs, usage, quality, storage] = await Promise.all([
		sql`SELECT s.slug,
		           count(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL)::int AS documents,
		           count(c.id)::int AS chunks,
		           max(d.fetched_at) AS last_document
		      FROM sources s
		      LEFT JOIN documents d ON d.source_id = s.id
		      LEFT JOIN chunks c ON c.document_id = d.id AND d.deleted_at IS NULL
		     GROUP BY s.slug ORDER BY s.slug`,
		sql`SELECT r.id, s.slug, r.status, r.started_at, r.finished_at, r.pages_seen,
		           r.pages_changed, r.pages_deleted, r.force, r.skip_existing, r.error
		      FROM crawl_runs r JOIN sources s ON s.id = r.source_id
		     ORDER BY r.started_at DESC LIMIT 10`,
		sql`SELECT date_trunc('day', m.created_at)::date AS day,
		           count(*) FILTER (WHERE c.mode = 'fast')::int AS fast,
		           count(*) FILTER (WHERE c.mode = 'deep')::int AS deep
		      FROM messages m
		      JOIN conversations c ON c.id = m.conversation_id
		     WHERE m.role = 'user' AND m.created_at > now() - interval '14 days'
		     GROUP BY 1 ORDER BY 1`,
		sql`SELECT
		      (SELECT count(*) FROM feedback WHERE rating > 0)::int AS up,
		      (SELECT count(*) FROM feedback WHERE rating < 0)::int AS down,
		      (SELECT count(*) FROM messages m
		         WHERE m.role = 'assistant'
		           AND NOT EXISTS (SELECT 1 FROM citations ct WHERE ct.message_id = m.id)
		      )::int AS uncited`,
		sql`SELECT (SELECT count(*) FROM app_users)::int AS users,
		           (SELECT count(*) FROM attachments)::int AS files,
		           (SELECT coalesce(sum(bytes), 0) FROM attachments)::text AS upload_bytes,
		           (SELECT count(*) FROM conversations)::int AS conversations,
		           (SELECT count(*) FROM hidden_conversations)::int AS hidden`
	]);

	return json({
		corpus,
		runs,
		usage,
		quality: quality[0],
		storage: { ...storage[0], upload_bytes: Number(storage[0].upload_bytes) }
	});
};
