import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import * as session from '$lib/server/session';
import { refresh } from '$lib/server/oidc';
import { isAdmin, isPrivileged, rememberUser } from '$lib/server/permissions';
import { metrics } from '$lib/server/metrics';
import { accessLog, log } from '$lib/server/log';

/**
 * Routes reachable without a session. Everything else requires login.
 *
 * `/metrics` is here because Prometheus scrapes with no cookie. It carries its
 * own optional bearer check; see routes/metrics/+server.ts.
 */
const PUBLIC = ['/login', '/auth/callback', '/logout', '/health', '/metrics', '/docs', '/api/docs'];

/** Refresh the access token this long before it expires, so an in-flight
 *  request never races the expiry. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Outermost handle: one timer and one counter around every request.
 *
 * It wraps `auth` rather than sitting beside it so that requests rejected by the
 * auth gate are still counted — a spike of 403s is exactly the kind of thing the
 * dashboard exists to show, and it would be invisible if instrumentation ran
 * only on the requests that made it through.
 *
 * The duration measured is time-to-response, not time-to-last-byte. /api/chat
 * returns its SSE Response almost immediately and then streams for up to three
 * minutes, so a single "request duration" covering both would make every other
 * route's latency unreadable. Turn latency is measured separately, at the
 * orchestrator, as chatgsi_chat_turn_duration_seconds.
 */
export const handle: Handle = async ({ event, resolve }) => {
	// Route ids are templates (`/api/conversations/[id]`), which is what keeps
	// this to one series per endpoint instead of one per conversation. It is null
	// for a 404, where the raw path would be attacker-controlled cardinality.
	const route = event.route.id ?? 'unmatched';
	const method = event.request.method;

	metrics.httpInFlight.inc();
	const started = process.hrtime.bigint();
	let status = 500;
	try {
		const response = await auth({ event, resolve });
		status = response.status;
		metrics.httpRequests.inc({ route, method, status });
		return response;
	} catch (err) {
		// A redirect or an `error()` is thrown, not returned. SvelteKit turns both
		// into responses after this point, so read the status off the thrown value
		// rather than reporting every one of them as a 500.
		status = (err as { status?: number })?.status ?? 500;
		metrics.httpRequests.inc({ route, method, status });
		if (status >= 500) {
			log.error('unhandled request error', { route, method, status, err });
		}
		throw err;
	} finally {
		metrics.httpInFlight.dec();
		const seconds = Number(process.hrtime.bigint() - started) / 1e9;
		metrics.httpDuration.observe({ route, method }, seconds);
		// The access log is the one thing in Loki that makes the rest navigable:
		// metrics say "p95 got worse", this says which requests, for whom.
		accessLog({
			route,
			method,
			path: event.url.pathname,
			status,
			durationMs: seconds * 1000,
			user: event.locals.user?.username
		});
	}
};

const auth: Handle = async ({ event, resolve }) => {
	if (config.devNoAuth) {
		event.locals.user = {
			sub: 'dev-user',
			username: 'dev',
			name: 'Dev User',
			email: 'dev@localhost',
			roles: ['llmbot-user', 'llmbot-admin']
		};
		return resolve(event);
	}

	const sessionId = event.cookies.get(session.SESSION_COOKIE);
	if (sessionId) {
		let current = await session.get(sessionId);

		if (current && current.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
			if (current.refreshToken) {
				try {
					current = { ...current, ...(await refresh(current.refreshToken)) };
					await session.put(sessionId, current);
					metrics.authEvents.inc({ event: 'refresh_ok' });
				} catch {
					// Refresh token expired or revoked -- drop the session and re-login.
					await session.destroy(sessionId);
					current = null;
					metrics.authEvents.inc({ event: 'refresh_failed' });
					log.info('session refresh failed, re-login required', { kind: 'auth' });
				}
			} else {
				await session.destroy(sessionId);
				current = null;
				metrics.authEvents.inc({ event: 'refresh_impossible' });
			}
		}

		if (current) {
			event.locals.user = session.toUser(current);
			// Mirror the identity locally so the admin UI can show a name next to a
			// sub. Fire-and-forget: a failed mirror must never break a request.
			rememberUser(event.locals.user).catch(() => {});
		} else {
			event.cookies.delete(session.SESSION_COOKIE, { path: '/' });
		}
	}

	const isPublic = PUBLIC.some((path) => event.url.pathname.startsWith(path));
	if (!isPublic && !event.locals.user) {
		metrics.httpDenied.inc({ reason: 'unauthenticated' });
		if (event.url.pathname.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'unauthenticated' }), {
				status: 401,
				headers: { 'content-type': 'application/json' }
			});
		}
		const returnTo = encodeURIComponent(event.url.pathname + event.url.search);
		redirect(303, `/login?returnTo=${returnTo}`);
	}

	// Authenticated but lacking the required realm role: authorised users only.
	if (!isPublic && event.locals.user && !event.locals.user.roles.includes('llmbot-user')) {
		metrics.httpDenied.inc({ reason: 'not_authorised' });
		return new Response('Your account is not authorised to use this service.', { status: 403 });
	}

	// Role-gated areas. Enforced here as well as in each endpoint: one missed
	// export in a +page.server.ts should not be the only thing standing between a
	// normal user and the admin surface.
	const path = event.url.pathname;
	if (path.startsWith('/admin') || path.startsWith('/api/admin')) {
		if (!isAdmin(event.locals.user)) {
			metrics.httpDenied.inc({ reason: 'not_admin' });
			return forbidden(event, 'admin only');
		}
	}
	if (path.startsWith('/management') || path.startsWith('/api/management')) {
		if (!isPrivileged(event.locals.user) && !isAdmin(event.locals.user)) {
			metrics.httpDenied.inc({ reason: 'not_manager' });
			return forbidden(event, 'not allowed');
		}
	}

	return resolve(event);
};

/** JSON for the API, plain text for a page: whichever the caller can read. */
function forbidden(event: { url: URL }, message: string): Response {
	if (event.url.pathname.startsWith('/api/')) {
		return new Response(JSON.stringify({ error: message }), {
			status: 403,
			headers: { 'content-type': 'application/json' }
		});
	}
	return new Response(message, { status: 403 });
}
