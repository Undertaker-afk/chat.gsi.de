import type { RequestHandler } from './$types';
import { redirect } from '@sveltejs/kit';
import { authorizationUrl } from '$lib/server/oidc';
import * as session from '$lib/server/session';
import { metrics } from '$lib/server/metrics';

export const GET: RequestHandler = async ({ url, cookies }) => {
	metrics.authEvents.inc({ event: 'login_start' });
	const returnTo = url.searchParams.get('returnTo') ?? '/';
	const { url: authUrl, pending } = await authorizationUrl(returnTo);

	const pendingId = session.newId();
	await session.putPending(pendingId, pending);
	cookies.set(session.PENDING_COOKIE, pendingId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	});

	redirect(303, authUrl);
};
