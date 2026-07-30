import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { listConversations } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const rows = await listConversations(locals.user.sub);
	return json(
		rows.map((c) => ({
			id: c.id,
			title: c.title,
			mode: c.mode,
			updatedAt: c.updated_at
		}))
	);
};
