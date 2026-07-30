/**
 * Crawler control from the admin UI (db/migrations/018).
 *
 * The frontend still cannot start a process — the crawler is a separate image
 * the web app has no handle on, and handing a web app a socket into the
 * container runtime is a large hole for a small button. So every control here
 * writes INTENT to `crawl_control` / `crawl_requests`, and `crawler tick` (a
 * short timer, or the CronJob in k8s/51-crawler-cron.yaml) acts on it.
 *
 * That is why the buttons say what they say. "Start" queues; it does not claim
 * the crawl is running. "Stop" asks a running crawl to wind down at its next
 * page boundary. A button that lied about having started something would be
 * worse than one that admits to queueing.
 */
import { error } from '@sveltejs/kit';
import { sql } from './db';
import { audit } from './permissions';
import type { User } from './session';
import { metrics } from './metrics';

export const CRAWL_MODES = ['incremental', 'changed-only', 'full', 'skip-existing'] as const;
export type CrawlMode = (typeof CRAWL_MODES)[number];

export const isCrawlMode = (value: unknown): value is CrawlMode =>
	typeof value === 'string' && (CRAWL_MODES as readonly string[]).includes(value);

/**
 * Interval bounds. The floor is 15 minutes and is also a CHECK constraint in
 * 018: wiki.gsi.de publishes `Crawl-delay: 5`, so a full pass takes hours, and
 * an interval shorter than the crawl means the source is crawled continuously
 * forever. The ceiling is a month, past which "scheduled" is a fiction.
 */
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 31;

export interface SourceControl {
	source_id: number;
	desired_state: 'running' | 'paused';
	stop_requested_at: string | null;
	interval_minutes: number | null;
	mode: CrawlMode;
	next_run_at: string | null;
	updated_by: string | null;
}

export interface RunningCrawl {
	id: number;
	source_id: number;
	started_at: string;
	heartbeat_at: string | null;
	mode: string;
	pages_seen: number;
	pages_changed: number;
	pages_skipped: number;
	pages_unfetched: number;
	pages_failed: number;
	pages_restricted: number;
	chunks_written: number;
	requested_by: string | null;
	/** Seconds since the last heartbeat. Over ~60 the crawler is not alive. */
	heartbeat_age: number | null;
}

/** Everything the sources tab needs, in one round trip. */
export async function sourcesWithControl() {
	const [sources, controls, running, recent] = await Promise.all([
		sql`
			SELECT s.id::int, s.slug, s.base_url, s.connector, s.enabled,
			       count(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL)::int AS documents,
			       count(DISTINCT d.id) FILTER (
			         WHERE d.deleted_at IS NULL AND d.revision IS NOT NULL
			       )::int AS documents_with_revision,
			       max(r.started_at) AS last_run,
			       (SELECT status FROM crawl_runs WHERE source_id = s.id
			         ORDER BY started_at DESC LIMIT 1) AS last_status,
			       (SELECT count(*) FROM crawl_requests q
			         WHERE q.source_id = s.id AND q.started_at IS NULL
			           AND q.cancelled_at IS NULL)::int AS pending
			  FROM sources s
			  LEFT JOIN documents d ON d.source_id = s.id
			  LEFT JOIN crawl_runs r ON r.source_id = s.id
			 GROUP BY s.id ORDER BY s.slug`,
		sql<SourceControl[]>`
			SELECT source_id::int, desired_state, stop_requested_at, interval_minutes,
			       mode, next_run_at, updated_by
			  FROM crawl_control`,
		sql<RunningCrawl[]>`
			SELECT id::int, source_id::int, started_at, heartbeat_at, mode,
			       pages_seen, pages_changed, pages_skipped, pages_unfetched,
			       pages_failed, pages_restricted, chunks_written, requested_by,
			       extract(epoch FROM now() - coalesce(heartbeat_at, started_at))::int
			         AS heartbeat_age
			  FROM crawl_runs WHERE status = 'running'`,
		// Last five runs per source, for the little history strip under each row.
		sql`
			SELECT id::int, source_id::int, status, mode, started_at, finished_at,
			       pages_seen, pages_changed, pages_deleted, pages_skipped,
			       pages_unfetched, pages_failed, chunks_written, error
			  FROM (SELECT *, row_number() OVER (PARTITION BY source_id
			                                     ORDER BY started_at DESC) AS rn
			          FROM crawl_runs) t
			 WHERE rn <= 5 ORDER BY source_id, started_at DESC`
	]);

	const byId = new Map(controls.map((c) => [c.source_id, c]));
	const runningById = new Map(running.map((r) => [r.source_id, r]));

	return sources.map((s) => ({
		...s,
		control: byId.get(s.id as number) ?? null,
		running: runningById.get(s.id as number) ?? null,
		runs: recent.filter((r) => r.source_id === s.id)
	}));
}

/** Ensure a control row exists. Sources created before 018 have none. */
async function ensureControl(sourceId: number) {
	await sql`
		INSERT INTO crawl_control (source_id) VALUES (${sourceId})
		ON CONFLICT (source_id) DO NOTHING`;
}

async function assertSource(sourceId: number): Promise<string> {
	const [row] = await sql<{ slug: string }[]>`SELECT slug FROM sources WHERE id = ${sourceId}`;
	if (!row) error(404, 'no such source');
	return row.slug;
}

/** Queue a crawl. Returns the request id; the crawl itself starts on the next tick. */
export async function requestCrawl(actor: User, sourceId: number, mode: CrawlMode) {
	const slug = await assertSource(sourceId);

	// One pending request per source. Clicking Start three times should mean
	// "crawl this", not "crawl this three times in a row" — the second and third
	// runs would find nothing changed and cost hours of wiki politeness delay.
	const [existing] = await sql<{ id: number }[]>`
		SELECT id::int FROM crawl_requests
		 WHERE source_id = ${sourceId} AND started_at IS NULL AND cancelled_at IS NULL
		 LIMIT 1`;
	if (existing) return { requestId: existing.id, alreadyQueued: true };

	const [row] = await sql<{ id: number }[]>`
		INSERT INTO crawl_requests (source_id, requested_by, mode, force, skip_existing)
		VALUES (${sourceId}, ${actor.sub}, ${mode},
		        ${mode === 'full'}, ${mode === 'skip-existing'})
		RETURNING id::int`;

	// A queued crawl also implicitly un-pauses: pressing Start while paused and
	// having nothing happen would be indistinguishable from a broken button.
	await ensureControl(sourceId);
	await sql`
		UPDATE crawl_control SET desired_state = 'running', updated_at = now(),
		       updated_by = ${actor.sub}
		 WHERE source_id = ${sourceId} AND desired_state = 'paused'`;

	metrics.crawlControlActions.inc({ action: 'start', mode });
	await audit(actor, 'crawl.request', slug, { mode });
	return { requestId: row.id, alreadyQueued: false };
}

/** Withdraw a queued crawl that has not been claimed yet. */
export async function cancelQueued(actor: User, sourceId: number) {
	const slug = await assertSource(sourceId);
	const rows = await sql<{ id: number }[]>`
		UPDATE crawl_requests SET cancelled_at = now()
		 WHERE source_id = ${sourceId} AND started_at IS NULL AND cancelled_at IS NULL
		RETURNING id::int`;
	metrics.crawlControlActions.inc({ action: 'cancel', mode: 'n/a' });
	await audit(actor, 'crawl.cancel', slug, { cancelled: rows.length });
	return { cancelled: rows.length };
}

export async function setPaused(actor: User, sourceId: number, paused: boolean) {
	const slug = await assertSource(sourceId);
	await ensureControl(sourceId);
	await sql`
		UPDATE crawl_control
		   SET desired_state = ${paused ? 'paused' : 'running'},
		       updated_at = now(), updated_by = ${actor.sub}
		 WHERE source_id = ${sourceId}`;
	metrics.crawlControlActions.inc({ action: paused ? 'pause' : 'resume', mode: 'n/a' });
	await audit(actor, paused ? 'crawl.pause' : 'crawl.resume', slug, {});
}

/**
 * Ask a running crawl to stop.
 *
 * The flag is a timestamp, and the crawler ignores any stop older than its own
 * start — so a stop pressed while nothing is running cannot lie in wait and kill
 * an unrelated run somebody starts an hour later. It is cleared by the CRAWLER
 * once a run has acknowledged it, never here: if this cleared it, a stop pressed
 * against no running crawl would vanish with no way to tell that apart from one
 * that worked.
 *
 * A stopped run deliberately does not run the delete sweep (see pipeline.py), so
 * pressing Stop can never empty the corpus.
 */
export async function requestStop(actor: User, sourceId: number) {
	const slug = await assertSource(sourceId);
	await ensureControl(sourceId);
	await sql`
		UPDATE crawl_control
		   SET stop_requested_at = now(), stop_requested_by = ${actor.sub},
		       updated_at = now(), updated_by = ${actor.sub}
		 WHERE source_id = ${sourceId}`;
	// Also withdraw anything queued: Stop meaning "stop the running one but
	// start the one behind it in a minute" would surprise everybody.
	await sql`
		UPDATE crawl_requests SET cancelled_at = now()
		 WHERE source_id = ${sourceId} AND started_at IS NULL AND cancelled_at IS NULL`;
	metrics.crawlControlActions.inc({ action: 'stop', mode: 'n/a' });
	await audit(actor, 'crawl.stop', slug, {});
}

/** Set (or clear, with null) the automatic interval and the mode it uses. */
export async function setSchedule(
	actor: User,
	sourceId: number,
	intervalMinutes: number | null,
	mode: CrawlMode
) {
	const slug = await assertSource(sourceId);
	if (intervalMinutes !== null) {
		if (!Number.isInteger(intervalMinutes)) error(400, 'interval must be whole minutes');
		if (intervalMinutes < MIN_INTERVAL_MINUTES) {
			error(400, `interval must be at least ${MIN_INTERVAL_MINUTES} minutes`);
		}
		if (intervalMinutes > MAX_INTERVAL_MINUTES) {
			error(400, `interval must be at most ${MAX_INTERVAL_MINUTES} minutes`);
		}
	}
	await ensureControl(sourceId);
	await sql`
		UPDATE crawl_control
		   SET interval_minutes = ${intervalMinutes},
		       mode = ${mode},
		       -- Changing the interval schedules from NOW rather than keeping an
		       -- old due time: setting "every 6 hours" on a source last crawled a
		       -- week ago should not fire immediately.
		       next_run_at = ${intervalMinutes === null ? null : sql`now() + make_interval(mins => ${intervalMinutes})`},
		       updated_at = now(), updated_by = ${actor.sub}
		 WHERE source_id = ${sourceId}`;
	metrics.crawlControlActions.inc({ action: 'schedule', mode });
	await audit(actor, 'crawl.schedule', slug, { intervalMinutes, mode });
}
