import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { assertAdmin, members, setGroupGrants } from '$lib/server/permissions';
import { sweep } from '$lib/server/revocation';

/** The ceiling. Narrowing it can take access away, so the sweep runs after. */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { kbIds?: unknown };
	if (!Array.isArray(body.kbIds)) error(400, 'kbIds must be an array');
	const kbIds = body.kbIds.map(Number).filter(Number.isFinite);

	const groupId = Number(params.id);
	await setGroupGrants(locals.user, groupId, kbIds);
	const affected = (await members(groupId)).map((m) => m.user_sub);
	const result = await sweep(affected);
	return json({ ok: true, ...result });
};
