import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { assertAdmin, auditLog } from '$lib/server/permissions';

export const GET: RequestHandler = async ({ locals, url }) => {
	assertAdmin(locals.user);
	const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
	return json({ entries: await auditLog(limit) });
};
