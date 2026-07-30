/**
 * Crawler control. Admin only (enforced here and in hooks.server.ts).
 *
 * One endpoint with an `action`, rather than five routes, because these are five
 * verbs against one object and the UI calls them from one place. See
 * $lib/server/crawl for why none of them start a process directly.
 */
import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { assertAdmin } from '$lib/server/permissions';
import {
	cancelQueued,
	isCrawlMode,
	requestCrawl,
	requestStop,
	setPaused,
	setSchedule,
	sourcesWithControl,
	type CrawlMode
} from '$lib/server/crawl';

export const GET: RequestHandler = async ({ locals }) => {
	assertAdmin(locals.user);
	return json({ sources: await sourcesWithControl() });
};

interface Body {
	action?: string;
	id?: number;
	mode?: string;
	intervalMinutes?: number | null;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	assertAdmin(locals.user);
	const user = locals.user;

	const body = (await request.json()) as Body;
	const id = Number(body.id);
	if (!Number.isInteger(id) || id <= 0) error(400, 'id is required');

	// Default to changed-only: it is the mode that costs the crawled site the
	// least, and an admin who wants a full pass says so.
	const mode: CrawlMode = isCrawlMode(body.mode) ? body.mode : 'changed-only';

	switch (body.action) {
		case 'start':
			return json(await requestCrawl(user, id, mode));

		case 'cancel':
			return json(await cancelQueued(user, id));

		case 'pause':
			await setPaused(user, id, true);
			return json({ ok: true });

		case 'resume':
			await setPaused(user, id, false);
			return json({ ok: true });

		case 'stop':
			await requestStop(user, id);
			return json({ ok: true });

		case 'schedule': {
			const raw = body.intervalMinutes;
			const interval = raw === null || raw === undefined ? null : Number(raw);
			if (interval !== null && !Number.isFinite(interval)) error(400, 'interval must be a number');
			await setSchedule(user, id, interval, mode);
			return json({ ok: true });
		}

		default:
			error(400, `unknown action: ${body.action ?? '(none)'}`);
	}
};
