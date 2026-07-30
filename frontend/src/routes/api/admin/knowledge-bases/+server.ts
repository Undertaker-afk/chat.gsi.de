import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { assertAdmin, audit, knowledgeBases } from '$lib/server/permissions';
import { sweep } from '$lib/server/revocation';
import { sql } from '$lib/server/db';

/**
 * The default knowledge bases: the public baseline everyone gets without a group.
 *
 * This route did not exist. The admin page called PATCH /api/admin/knowledge-bases
 * from its "Standard" switch, got a 404, and its `if (res.ok)` swallowed it -- so
 * the switch sprang back and reported nothing. Anything the UI calls has to
 * exist here, and anything that fails has to say so.
 */

/** Replace the whole default set. Batch, because the UI saves a staged edit. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { defaultKbIds?: unknown };
	if (!Array.isArray(body.defaultKbIds)) error(400, 'defaultKbIds must be an array');
	const ids = [...new Set(body.defaultKbIds.map(Number).filter(Number.isFinite))];

	const existing = await sql<{ id: number }[]>`SELECT id::int FROM knowledge_bases`;
	const known = new Set(existing.map((r) => r.id));
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length) error(400, `no such knowledge base: ${unknown.join(', ')}`);

	await sql`UPDATE knowledge_bases SET is_default = (id = ANY(${ids}))`;
	await audit(locals.user, 'kb.defaults', null, { kbIds: ids });

	// Unscoped: the default set is the baseline for every account, including
	// people in no group at all, so there is no useful subset to sweep.
	const result = await sweep();
	return json({ ok: true, knowledgeBases: await knowledgeBases(), ...result });
};

/** Single toggle. Kept so an older client, or a script, still has a working call. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { id?: number; isDefault?: boolean };
	if (!body.id) error(400, 'id is required');

	const [row] = await sql<{ slug: string }[]>`
		UPDATE knowledge_bases SET is_default = ${body.isDefault === true}
		 WHERE id = ${body.id}
		RETURNING slug`;
	if (!row) error(404, 'no such knowledge base');

	await audit(locals.user, body.isDefault ? 'kb.default.on' : 'kb.default.off', row.slug, {});
	const result = await sweep();
	return json({ ok: true, ...result });
};
