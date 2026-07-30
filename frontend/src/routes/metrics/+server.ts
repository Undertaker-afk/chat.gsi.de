/**
 * The one metrics endpoint.
 *
 * Prometheus has a single scrape target for this whole stack. Everything behind
 * it — the app's own counters, Postgres, SeaweedFS, Valkey, Keycloak, and the
 * crawler's run history — is assembled by $lib/server/metrics into one exposition
 * (see collectors.ts for why it is built that way).
 *
 * Auth: this route is listed as PUBLIC in hooks.server.ts, because Prometheus
 * scrapes it with no session. On the isolated lab subnet that is the intended
 * state and METRICS_TOKEN is unset (AGENTS.md §1: do not add auth hardening
 * unless asked). Setting METRICS_TOKEN turns on bearer auth for the day this
 * leaves the lab — the exposition names users in
 * chatgsi_user_stored_bytes, so it is not something to publish unthinkingly.
 */
import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { renderMetrics } from '$lib/server/metrics';
import { config } from '$lib/server/config';

export const GET: RequestHandler = async ({ request }) => {
	if (!config.metrics.enabled) error(404, 'metrics disabled');

	const token = config.metrics.token;
	if (token) {
		const header = request.headers.get('authorization') ?? '';
		const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
		// Length check first: timingSafeEqual throws on a length mismatch, and the
		// length of a token is not the secret.
		if (presented.length !== token.length || !timingSafeEqualStr(presented, token)) {
			error(401, 'unauthorized');
		}
	}

	return new Response(await renderMetrics(), {
		headers: {
			// version=0.0.4 is the text exposition format. Prometheus accepts a bare
			// text/plain, but naming the version keeps OpenMetrics parsers happy too.
			'content-type': 'text/plain; version=0.0.4; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
};

function timingSafeEqualStr(a: string, b: string): boolean {
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
