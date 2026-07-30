import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { assertAdmin, audit } from '$lib/server/permissions';
import { sql } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
	assertAdmin(locals.user);
	const sources = await sql`
		SELECT s.id, s.slug, s.base_url, s.connector, s.enabled,
		       count(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL)::int AS documents,
		       max(r.started_at) AS last_run,
		       (SELECT status FROM crawl_runs WHERE source_id = s.id
		         ORDER BY started_at DESC LIMIT 1) AS last_status,
		       (SELECT count(*) FROM crawl_requests q
		         WHERE q.source_id = s.id AND q.started_at IS NULL)::int AS pending
		  FROM sources s
		  LEFT JOIN documents d ON d.source_id = s.id
		  LEFT JOIN crawl_runs r ON r.source_id = s.id
		 GROUP BY s.id ORDER BY s.slug`;
	return json({ sources });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { id?: number; enabled?: boolean };
	if (!body.id) error(400, 'id is required');
	const [row] = await sql<{ slug: string }[]>`
		UPDATE sources SET enabled = ${body.enabled === true} WHERE id = ${body.id}
		RETURNING slug`;
	if (!row) error(404, 'no such source');
	await audit(locals.user, body.enabled ? 'source.enable' : 'source.disable', row.slug, {});
	return json({ ok: true });
};

/**
 * Request a crawl.
 *
 * The frontend container cannot start the crawler -- that is a separate image
 * run by podman on the host. So this queues the request and the existing crawl
 * unit picks it up (`crawler crawl --requested`, wired to a short systemd
 * timer). An admin button that lies about having started something would be
 * worse than one that says "queued".
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { id?: number; force?: boolean; skipExisting?: boolean };
	if (!body.id) error(400, 'id is required');

	const [row] = await sql<{ id: number }[]>`
		INSERT INTO crawl_requests (source_id, requested_by, force, skip_existing)
		VALUES (${body.id}, ${locals.user.sub}, ${body.force === true}, ${body.skipExisting === true})
		RETURNING id`;
	await audit(locals.user, 'crawl.request', `source:${body.id}`, {
		force: body.force === true,
		skipExisting: body.skipExisting === true
	});
	return json({ requestId: row.id });
};
