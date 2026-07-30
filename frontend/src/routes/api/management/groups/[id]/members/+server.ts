import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { assertCanManage, members, setMemberGrants } from '$lib/server/permissions';
import { sweep } from '$lib/server/revocation';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const groupId = Number(params.id);
	await assertCanManage(locals.user, groupId);
	return json({ members: await members(groupId) });
};

/**
 * Narrow (or release) one member's access.
 *
 * `kbIds: null` clears the customisation and returns them to the group's full
 * ceiling. Anything outside the ceiling is refused by setMemberGrants -- the
 * check lives there, not here, so no route can forget it.
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const groupId = Number(params.id);
	await assertCanManage(locals.user, groupId);

	const body = (await request.json()) as { userSub?: string; kbIds?: number[] | null };
	if (!body.userSub) error(400, 'userSub is required');

	const kbIds = body.kbIds === null || body.kbIds === undefined ? null : body.kbIds.map(Number);
	await setMemberGrants(locals.user, groupId, body.userSub, kbIds);
	const result = await sweep([body.userSub]);
	return json({ ok: true, ...result });
};
