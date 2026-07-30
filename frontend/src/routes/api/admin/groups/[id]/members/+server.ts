import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { addMember, assertAdmin, removeMember, setManager } from '$lib/server/permissions';
import { sweep } from '$lib/server/revocation';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { userSub?: string; isManager?: boolean };
	if (!body.userSub) error(400, 'userSub is required');

	const groupId = Number(params.id);
	await addMember(locals.user, groupId, body.userSub);
	if (body.isManager) await setManager(locals.user, groupId, body.userSub, true);
	// Joining a group only ever adds access, but the sweep also un-hides what a
	// previous revocation took away -- which is exactly what should happen here.
	await sweep([body.userSub]);
	return json({ ok: true });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { userSub?: string; isManager?: boolean };
	if (!body.userSub) error(400, 'userSub is required');
	await setManager(locals.user, Number(params.id), body.userSub, body.isManager === true);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	assertAdmin(locals.user);
	const userSub = url.searchParams.get('userSub');
	if (!userSub) error(400, 'userSub is required');
	await removeMember(locals.user, Number(params.id), userSub);
	await sweep([userSub]);
	return json({ ok: true });
};
