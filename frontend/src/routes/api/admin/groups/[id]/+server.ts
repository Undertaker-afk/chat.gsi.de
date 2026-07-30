import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { assertAdmin, deleteGroup, members } from '$lib/server/permissions';
import { sweep } from '$lib/server/revocation';

export const GET: RequestHandler = async ({ locals, params }) => {
	assertAdmin(locals.user);
	return json({ members: await members(Number(params.id)) });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	assertAdmin(locals.user);
	// Read the membership first: after the cascade there is nobody left to
	// re-evaluate, and those are exactly the people who just lost access.
	const affected = (await members(Number(params.id))).map((m) => m.user_sub);
	await deleteGroup(locals.user, Number(params.id));
	await sweep(affected);
	return json({ ok: true });
};
