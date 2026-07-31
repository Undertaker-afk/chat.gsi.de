import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { assertAdmin } from '$lib/server/permissions';
import { purgeUserData } from '$lib/server/admin';

/** Delete a user and all their data — chats, files, uploads, the works. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	assertAdmin(locals.user);

	const sub = params.sub;
	if (!sub) error(400, 'sub is required');

	const result = await purgeUserData(sub);
	return json(result);
};
