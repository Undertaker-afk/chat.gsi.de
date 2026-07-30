import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';
import { endSessionUrl } from '$lib/server/oidc';
import * as session from '$lib/server/session';
import { metrics } from '$lib/server/metrics';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const sessionId = cookies.get(session.SESSION_COOKIE);
	let idToken: string | undefined;

	if (sessionId) {
		idToken = (await session.get(sessionId))?.idToken;
		await session.destroy(sessionId);
		cookies.delete(session.SESSION_COOKIE, { path: '/' });
		metrics.authEvents.inc({ event: 'logout' });
	}

	if (idToken) redirect(303, await endSessionUrl(idToken, url.origin));
	redirect(303, '/');
};
