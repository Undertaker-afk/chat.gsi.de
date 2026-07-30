import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { assertAdmin, createGroup, groups, knowledgeBases } from '$lib/server/permissions';

export const GET: RequestHandler = async ({ locals }) => {
	assertAdmin(locals.user);
	const [list, kbs] = await Promise.all([groups(), knowledgeBases()]);
	return json({ groups: list, knowledgeBases: kbs });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	assertAdmin(locals.user);
	const body = (await request.json()) as { name?: string; description?: string };
	const name = (body.name ?? '').trim();
	if (!name) error(400, 'name is required');
	const id = await createGroup(locals.user, name, body.description?.trim() || null);
	return json({ id });
};
