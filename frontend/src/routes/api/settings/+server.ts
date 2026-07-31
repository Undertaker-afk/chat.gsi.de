/**
 * User preferences. Today: the interface language.
 *
 * POST /api/settings  { "language": "en" }  ->  saved on app_users.
 * The client updates its own language store immediately; this makes it stick
 * across sessions and devices.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setLanguage } from '$lib/server/preferences';
import { isLanguage } from '$lib/language.svelte';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');

	const body = await request.json().catch(() => ({}));
	const { language } = body ?? {};

	if (!isLanguage(language)) error(400, 'unknown language');

	await setLanguage(locals.user.sub, language);
	return json({ ok: true, language });
};
