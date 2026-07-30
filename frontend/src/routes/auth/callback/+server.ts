import type { RequestHandler } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { exchange } from '$lib/server/oidc';
import * as session from '$lib/server/session';
import { metrics } from '$lib/server/metrics';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const pendingId = cookies.get(session.PENDING_COOKIE);
	if (!pendingId) {
		metrics.authEvents.inc({ event: 'login_failed' });
		error(400, 'no pending authentication -- start again at /login');
	}

	// Single-use: consumed here, so a replayed callback cannot succeed twice.
	const pending = await session.takePending(pendingId);
	cookies.delete(session.PENDING_COOKIE, { path: '/' });
	if (!pending) {
		metrics.authEvents.inc({ event: 'login_failed' });
		error(400, 'authentication expired -- start again at /login');
	}

	// Token exchange is the step that fails on a client-secret mismatch, long
	// after the login page appeared to work (AGENTS.md §6). Counting it apart
	// from the two checks above is what makes that specific failure legible.
	let tokens;
	try {
		tokens = await exchange(url, pending);
	} catch (err) {
		metrics.authEvents.inc({ event: 'token_exchange_failed' });
		throw err;
	}

	const sessionId = session.newId();
	await session.put(sessionId, tokens);
	cookies.set(session.SESSION_COOKIE, sessionId, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 12 * 60 * 60
	});

	metrics.authEvents.inc({ event: 'login_ok' });

	// Only ever redirect to a local path -- an absolute returnTo would be an open redirect.
	const target = pending.returnTo.startsWith('/') ? pending.returnTo : '/';
	redirect(303, target);
};
