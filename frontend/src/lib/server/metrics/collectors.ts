/**
 * Scrape-time collectors: everything /metrics reports that is NOT counted by
 * this process as it runs.
 *
 * This is the half of the design that lets the stack have ONE metrics endpoint
 * instead of six. Postgres, SeaweedFS, Valkey, Keycloak and the crawler are not
 * asked to export anything; the frontend queries them when Prometheus scrapes
 * and renders the answers into the same exposition as its own counters. The cost
 * is one round of fan-out per scrape; the benefit is a single scrape target, a
 * single ingress, and no sidecar exporters on a laptop-sized node.
 *
 * Two rules keep that from becoming a liability:
 *
 *   1. Every collector has a timeout. A hung backend must not hold the scrape
 *      open past Prometheus's own timeout, or the whole endpoint reads as down.
 *   2. Expensive collectors are cached (METRICS_DB_CACHE_SECONDS, default 15s).
 *      Prometheus scrapes every 15s and a human hammering refresh must not turn
 *      the dashboard into a load generator against the database.
 *
 * A collector that throws is reported as `chatgsi_collector_up{...} 0` by the
 * registry rather than removing its metrics silently — see registry.ts.
 */
import { sql } from '../db';
import { config } from '../config';
import { registry, type Collector } from './registry';
import { sessionCount, valkeyInfo } from '../session';

/** Escape a label value the same way the registry does for its own metrics. */
const lv = (value: string | number) =>
	String(value)
		.replace(/[\\"\n]/g, '_')
		.slice(0, 120);

const line = (name: string, labels: Record<string, string | number>, value: number) => {
	const parts = Object.entries(labels).map(([k, v]) => `${k}="${lv(v)}"`);
	const suffix = parts.length ? `{${parts.join(',')}}` : '';
	return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
};

/** `# HELP`/`# TYPE` for a collected family. Emitted once per family per scrape. */
const head = (name: string, help: string, type: 'gauge' | 'counter' = 'gauge') => [
	`# HELP ${name} ${help}`,
	`# TYPE ${name} ${type}`
];

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await fn(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

async function getJson<T>(url: string, ms: number): Promise<T> {
	return withTimeout(ms, async (signal) => {
		const res = await fetch(url, { signal });
		if (!res.ok) throw new Error(`${url} -> ${res.status}`);
		return (await res.json()) as T;
	});
}

/**
 * Memoise a collector's output for `ttlMs`.
 *
 * Failures are NOT cached: a backend that just came back up should show up on
 * the next scrape rather than 15 seconds later. In-flight calls are shared, so
 * two overlapping scrapes cost one query.
 */
function cached(ttlMs: number, fn: () => Promise<string[]>): () => Promise<string[]> {
	let at = 0;
	let value: string[] = [];
	let inFlight: Promise<string[]> | null = null;

	return async () => {
		if (Date.now() - at < ttlMs) return value;
		inFlight ??= fn()
			.then((result) => {
				value = result;
				at = Date.now();
				return result;
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};
}

const up = (name: string, ok: boolean) => [
	...head('chatgsi_collector_up', '1 when the named backend answered this scrape.'),
	line('chatgsi_collector_up', { collector: name }, ok ? 1 : 0)
];

// --- Node runtime -----------------------------------------------------------

/**
 * The usual process_* / nodejs_* set, hand-rolled from process.* rather than
 * pulled from prom-client. Everything here is a synchronous read of counters the
 * runtime already keeps, so it is free to collect.
 */
const runtime: Collector = {
	name: 'runtime',
	collect() {
		const mem = process.memoryUsage();
		const cpu = process.cpuUsage();
		const rl = process.resourceUsage?.();

		return [
			...head('process_resident_memory_bytes', 'Resident set size of the frontend process.'),
			line('process_resident_memory_bytes', {}, mem.rss),
			...head('process_heap_bytes', 'V8 heap size, total and used.'),
			line('process_heap_bytes', { state: 'total' }, mem.heapTotal),
			line('process_heap_bytes', { state: 'used' }, mem.heapUsed),
			line('process_heap_bytes', { state: 'external' }, mem.external),
			...head(
				'process_cpu_seconds_total',
				'CPU time consumed by this process, user and system.',
				'counter'
			),
			line('process_cpu_seconds_total', { mode: 'user' }, cpu.user / 1e6),
			line('process_cpu_seconds_total', { mode: 'system' }, cpu.system / 1e6),
			...head('process_start_time_seconds', 'Unix start time of the process.'),
			line('process_start_time_seconds', {}, (Date.now() - process.uptime() * 1000) / 1000),
			...head('nodejs_active_handles', 'libuv handles and requests currently open.'),
			line('nodejs_active_handles', { kind: 'handles' }, activeCount('_getActiveHandles')),
			line('nodejs_active_handles', { kind: 'requests' }, activeCount('_getActiveRequests')),
			...head('nodejs_event_loop_lag_seconds', 'Most recent measured event-loop lag.'),
			line('nodejs_event_loop_lag_seconds', {}, lastLag),
			...head('process_open_fds', 'File descriptors, where the platform reports them.'),
			line('process_open_fds', {}, rl ? rl.fsRead + rl.fsWrite : 0)
		];
	}
};

/** `process._getActiveHandles` is internal and undocumented; treat it as optional. */
function activeCount(method: '_getActiveHandles' | '_getActiveRequests'): number {
	const fn = (process as unknown as Record<string, unknown>)[method];
	return typeof fn === 'function' ? ((fn as () => unknown[]).call(process).length ?? 0) : 0;
}

/**
 * Event-loop lag, sampled continuously rather than measured during the scrape.
 *
 * Measuring it inside collect() would report the lag caused by the scrape's own
 * fan-out, which is exactly the number nobody wants. A 5s unref'd timer costs
 * nothing and never keeps the process alive.
 */
let lastLag = 0;
function startLagSampler() {
	const period = 5000;
	let expected = Date.now() + period;
	const timer = setInterval(() => {
		const now = Date.now();
		lastLag = Math.max(0, now - expected) / 1000;
		expected = now + period;
	}, period);
	timer.unref?.();
}

// --- Postgres ---------------------------------------------------------------

interface CorpusRow {
	slug: string;
	documents: number;
	chunks: number;
	embedded: number;
	last_document: Date | null;
}

/**
 * The application's own state, as counted by the database.
 *
 * This is where "file usage" comes from. Two different truths are exposed side
 * by side on purpose:
 *
 *   chatgsi_stored_bytes   what the app believes users have stored (the numbers
 *                          the quota is enforced against)
 *   chatgsi_object_storage_used_bytes
 *                          what SeaweedFS actually holds on disk
 *
 * They should track each other. A widening gap means orphaned objects — an
 * upload whose row insert failed, or a delete that never reached the gateway —
 * and it is the single most useful storage alert in the stack.
 */
const postgres: Collector = {
	name: 'postgres',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const [totals, corpus, runs, dbsize, topUsers, modes] = await Promise.all([
			sql<
				{
					users: number;
					active_users_7d: number;
					conversations: number;
					hidden: number;
					messages: number;
					attachments: number;
					attachment_bytes: string;
					generated_files: number;
					generated_bytes: string;
					chat_bytes: string;
					groups: number;
					knowledge_bases: number;
					feedback_up: number;
					feedback_down: number;
				}[]
			>`
				SELECT (SELECT count(*) FROM app_users)::int AS users,
				       (SELECT count(*) FROM app_users
				         WHERE last_seen_at > now() - interval '7 days')::int AS active_users_7d,
				       (SELECT count(*) FROM conversations)::int AS conversations,
				       (SELECT count(*) FROM hidden_conversations)::int AS hidden,
				       (SELECT count(*) FROM messages)::int AS messages,
				       (SELECT count(*) FROM attachments)::int AS attachments,
				       (SELECT coalesce(sum(bytes), 0) FROM attachments)::text AS attachment_bytes,
				       (SELECT count(*) FROM generated_files)::int AS generated_files,
				       (SELECT coalesce(sum(bytes), 0) FROM generated_files)::text AS generated_bytes,
				       (SELECT coalesce(sum(octet_length(content)
				                          + coalesce(octet_length(trace::text), 0)), 0)
				          FROM messages)::text AS chat_bytes,
				       (SELECT count(*) FROM groups)::int AS groups,
				       (SELECT count(*) FROM knowledge_bases)::int AS knowledge_bases,
				       (SELECT count(*) FROM feedback WHERE rating > 0)::int AS feedback_up,
				       (SELECT count(*) FROM feedback WHERE rating < 0)::int AS feedback_down`,
			sql<CorpusRow[]>`
				SELECT s.slug,
				       count(DISTINCT d.id) FILTER (WHERE d.deleted_at IS NULL)::int AS documents,
				       count(c.id)::int AS chunks,
				       count(c.id) FILTER (WHERE c.embedding IS NOT NULL)::int AS embedded,
				       max(d.fetched_at) AS last_document
				  FROM sources s
				  LEFT JOIN documents d ON d.source_id = s.id
				  LEFT JOIN chunks c ON c.document_id = d.id AND d.deleted_at IS NULL
				 GROUP BY s.slug`,
			sql<
				{ slug: string; status: string; runs: number; last_finished: Date | null }[]
			>`
				SELECT s.slug, r.status, count(*)::int AS runs, max(r.finished_at) AS last_finished
				  FROM crawl_runs r JOIN sources s ON s.id = r.source_id
				 GROUP BY s.slug, r.status`,
			sql<{ bytes: string }[]>`SELECT pg_database_size(current_database())::text AS bytes`,
			// Bounded to 20 rows: a per-user gauge is genuinely useful on the storage
			// dashboard ("who filled the disk"), and a series per user is not.
			sql<{ who: string; bytes: string }[]>`
				SELECT coalesce(u.username, a.user_sub) AS who, sum(a.bytes)::text AS bytes
				  FROM attachments a
				  LEFT JOIN app_users u ON u.sub = a.user_sub
				 GROUP BY 1 ORDER BY sum(a.bytes) DESC LIMIT 20`,
			sql<{ mode: string; conversations: number }[]>`
				SELECT mode, count(*)::int AS conversations FROM conversations GROUP BY mode`
		]);

		const t = totals[0];
		const out = [
			...up('postgres', true),
			...head('chatgsi_users', 'Users known to the app (they have logged in at least once).'),
			line('chatgsi_users', { window: 'all' }, t.users),
			line('chatgsi_users', { window: '7d' }, t.active_users_7d),
			...head('chatgsi_conversations', 'Conversations, by visibility.'),
			line('chatgsi_conversations', { state: 'visible' }, t.conversations - t.hidden),
			line('chatgsi_conversations', { state: 'hidden' }, t.hidden),
			...head('chatgsi_messages', 'Messages stored.'),
			line('chatgsi_messages', {}, t.messages),
			...head('chatgsi_files', 'Files stored, by kind.'),
			line('chatgsi_files', { kind: 'upload' }, t.attachments),
			line('chatgsi_files', { kind: 'generated' }, t.generated_files),
			...head(
				'chatgsi_stored_bytes',
				'Bytes the app accounts against user quota, by kind. Compare with chatgsi_object_storage_used_bytes.'
			),
			line('chatgsi_stored_bytes', { kind: 'upload' }, Number(t.attachment_bytes)),
			line('chatgsi_stored_bytes', { kind: 'generated' }, Number(t.generated_bytes)),
			line('chatgsi_stored_bytes', { kind: 'chat' }, Number(t.chat_bytes)),
			...head('chatgsi_user_quota_bytes', 'Per-user storage quota (UPLOAD_QUOTA_BYTES).'),
			line('chatgsi_user_quota_bytes', {}, config.uploads.quotaBytes),
			...head('chatgsi_groups', 'Access-control groups.'),
			line('chatgsi_groups', {}, t.groups),
			...head('chatgsi_knowledge_bases', 'Knowledge bases defined.'),
			line('chatgsi_knowledge_bases', {}, t.knowledge_bases),
			...head('chatgsi_feedback_total', 'Message ratings, by direction.', 'counter'),
			line('chatgsi_feedback_total', { rating: 'up' }, t.feedback_up),
			line('chatgsi_feedback_total', { rating: 'down' }, t.feedback_down),
			...head('chatgsi_postgres_size_bytes', 'On-disk size of the application database.'),
			line('chatgsi_postgres_size_bytes', {}, Number(dbsize[0].bytes))
		];

		out.push(
			...head('chatgsi_conversations_by_mode', 'Conversations by the mode they were started in.')
		);
		for (const m of modes) {
			out.push(line('chatgsi_conversations_by_mode', { mode: m.mode }, m.conversations));
		}

		out.push(...head('chatgsi_corpus_documents', 'Live documents per source.'));
		for (const c of corpus) out.push(line('chatgsi_corpus_documents', { source: c.slug }, c.documents));
		out.push(...head('chatgsi_corpus_chunks', 'Chunks per source, total and embedded.'));
		for (const c of corpus) {
			out.push(line('chatgsi_corpus_chunks', { source: c.slug, state: 'all' }, c.chunks));
			out.push(line('chatgsi_corpus_chunks', { source: c.slug, state: 'embedded' }, c.embedded));
		}
		out.push(
			...head(
				'chatgsi_corpus_last_document_timestamp_seconds',
				'When the newest document of a source was fetched. Corpus freshness: alert on time() - this.'
			)
		);
		for (const c of corpus) {
			out.push(
				line(
					'chatgsi_corpus_last_document_timestamp_seconds',
					{ source: c.slug },
					c.last_document ? new Date(c.last_document).getTime() / 1000 : 0
				)
			);
		}

		// The crawler is a batch Job with no long-lived process to scrape, so its
		// metrics are derived from the crawl_runs table it already writes. That is
		// also why they survive the Job's pod being garbage-collected.
		out.push(...head('chatgsi_crawl_runs_total', 'Crawl runs recorded, by source and status.', 'counter'));
		for (const r of runs) out.push(line('chatgsi_crawl_runs_total', { source: r.slug, status: r.status }, r.runs));
		out.push(
			...head(
				'chatgsi_crawl_last_finished_timestamp_seconds',
				'When a crawl of this source last reached this status.'
			)
		);
		for (const r of runs) {
			out.push(
				line(
					'chatgsi_crawl_last_finished_timestamp_seconds',
					{ source: r.slug, status: r.status },
					r.last_finished ? new Date(r.last_finished).getTime() / 1000 : 0
				)
			);
		}

		out.push(
			...head(
				'chatgsi_user_stored_bytes',
				'Attachment bytes per user, top 20 only. Deliberately capped — one series per user is not a metric, it is a database.'
			)
		);
		for (const u of topUsers) {
			out.push(line('chatgsi_user_stored_bytes', { user: u.who }, Number(u.bytes)));
		}

		return out;
	})
};

// --- crawler ----------------------------------------------------------------

/**
 * Crawler telemetry, read from the tables the crawler already writes.
 *
 * The crawler is a batch Job: by the time anything scrapes, the process is gone
 * and its pod may have been garbage-collected. So the run history in
 * `crawl_runs` IS the metric source, and this collector turns it into a
 * time series. The upside beyond convenience is that the history survives
 * everything — a run from last month is still on the dashboard.
 *
 * A *running* crawl is visible too, through the heartbeat the pipeline writes
 * every five seconds (migration 018). That is what makes "is it stuck" a
 * question the dashboard can answer: a crawl of the wiki legitimately takes
 * hours, so elapsed time proves nothing and heartbeat age proves everything.
 */
const crawler: Collector = {
	name: 'crawler',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const [runs, latest, active, control, queue] = await Promise.all([
			sql<{ slug: string; status: string; mode: string; runs: number }[]>`
				SELECT s.slug, r.status, r.mode, count(*)::int AS runs
				  FROM crawl_runs r JOIN sources s ON s.id = r.source_id
				 GROUP BY s.slug, r.status, r.mode`,
			sql<
				{
					slug: string;
					status: string;
					mode: string;
					finished_at: Date | null;
					duration: number | null;
					seen: number;
					changed: number;
					skipped: number;
					unfetched: number;
					deleted: number;
					failed: number;
					restricted: number;
					chunks: number;
					bytes: string;
				}[]
			>`
				SELECT DISTINCT ON (s.slug) s.slug, r.status, r.mode, r.finished_at,
				       extract(epoch FROM r.finished_at - r.started_at)::float AS duration,
				       r.pages_seen AS seen, r.pages_changed AS changed,
				       r.pages_skipped AS skipped, r.pages_unfetched AS unfetched,
				       r.pages_deleted AS deleted, r.pages_failed AS failed,
				       r.pages_restricted AS restricted, r.chunks_written AS chunks,
				       r.bytes_fetched::text AS bytes
				  FROM crawl_runs r JOIN sources s ON s.id = r.source_id
				 WHERE r.finished_at IS NOT NULL
				 ORDER BY s.slug, r.started_at DESC`,
			sql<
				{
					slug: string;
					mode: string;
					elapsed: number;
					heartbeat_age: number;
					seen: number;
					changed: number;
					unfetched: number;
					failed: number;
				}[]
			>`
				SELECT s.slug, r.mode,
				       extract(epoch FROM now() - r.started_at)::float AS elapsed,
				       extract(epoch FROM now() - coalesce(r.heartbeat_at, r.started_at))::float
				         AS heartbeat_age,
				       r.pages_seen AS seen, r.pages_changed AS changed,
				       r.pages_unfetched AS unfetched, r.pages_failed AS failed
				  FROM crawl_runs r JOIN sources s ON s.id = r.source_id
				 WHERE r.status = 'running'`,
			sql<
				{
					slug: string;
					desired_state: string;
					mode: string;
					interval_minutes: number | null;
					due_in: number | null;
					stop_pending: boolean;
				}[]
			>`
				SELECT s.slug, c.desired_state, c.mode, c.interval_minutes,
				       extract(epoch FROM c.next_run_at - now())::float AS due_in,
				       (c.stop_requested_at IS NOT NULL) AS stop_pending
				  FROM crawl_control c JOIN sources s ON s.id = c.source_id`,
			sql<{ slug: string; pending: number; oldest: number | null }[]>`
				SELECT s.slug,
				       count(*) FILTER (WHERE q.started_at IS NULL
				                          AND q.cancelled_at IS NULL)::int AS pending,
				       extract(epoch FROM now() - min(q.requested_at) FILTER (
				         WHERE q.started_at IS NULL AND q.cancelled_at IS NULL))::float AS oldest
				  FROM sources s LEFT JOIN crawl_requests q ON q.source_id = s.id
				 GROUP BY s.slug`
		]);

		const out: string[] = [...up('crawler', true)];

		out.push(...head('chatgsi_crawl_runs_by_mode_total', 'Crawl runs by source, mode and status.', 'counter'));
		for (const r of runs) {
			out.push(
				line('chatgsi_crawl_runs_by_mode_total', { source: r.slug, mode: r.mode, status: r.status }, r.runs)
			);
		}

		// The most recent finished run per source, broken out. These are gauges,
		// not counters: "what did the last crawl do" is the question an admin
		// actually asks, and a rate() over a counter cannot answer it.
		out.push(...head('chatgsi_crawl_last_run_pages', 'Pages in the most recent finished run, by outcome.'));
		for (const r of latest) {
			const s = r.slug;
			out.push(line('chatgsi_crawl_last_run_pages', { source: s, outcome: 'seen' }, r.seen));
			out.push(line('chatgsi_crawl_last_run_pages', { source: s, outcome: 'changed' }, r.changed));
			out.push(line('chatgsi_crawl_last_run_pages', { source: s, outcome: 'unchanged' }, r.skipped));
			// The payoff of changed-only: pages never requested at all.
			out.push(line('chatgsi_crawl_last_run_pages', { source: s, outcome: 'not_fetched' }, r.unfetched));
			out.push(line('chatgsi_crawl_last_run_pages', { source: s, outcome: 'deleted' }, r.deleted));
			out.push(line('chatgsi_crawl_last_run_pages', { source: s, outcome: 'failed' }, r.failed));
			out.push(line('chatgsi_crawl_last_run_pages', { source: s, outcome: 'restricted' }, r.restricted));
		}
		out.push(...head('chatgsi_crawl_last_run_duration_seconds', 'How long the most recent finished run took.'));
		for (const r of latest) {
			out.push(line('chatgsi_crawl_last_run_duration_seconds', { source: r.slug, mode: r.mode }, r.duration ?? 0));
		}
		out.push(...head('chatgsi_crawl_last_run_chunks', 'Chunks written by the most recent finished run.'));
		for (const r of latest) out.push(line('chatgsi_crawl_last_run_chunks', { source: r.slug }, r.chunks));
		out.push(...head('chatgsi_crawl_last_run_bytes_fetched', 'Bytes fetched by the most recent finished run.'));
		for (const r of latest) {
			out.push(line('chatgsi_crawl_last_run_bytes_fetched', { source: r.slug }, Number(r.bytes)));
		}
		out.push(
			...head('chatgsi_crawl_last_run_ok', '1 when the most recent finished run ended ok, 0 otherwise.')
		);
		for (const r of latest) {
			out.push(line('chatgsi_crawl_last_run_ok', { source: r.slug, status: r.status }, r.status === 'ok' ? 1 : 0));
		}

		// Live runs.
		out.push(...head('chatgsi_crawl_active', '1 while a crawl of this source is running.'));
		out.push(...head('chatgsi_crawl_active_elapsed_seconds', 'How long the running crawl has been going.'));
		out.push(
			...head(
				'chatgsi_crawl_heartbeat_age_seconds',
				'Seconds since the running crawl last wrote a heartbeat. Over ~60 means the crawler died; elapsed time alone cannot tell you that, because a full wiki crawl takes hours.'
			)
		);
		out.push(...head('chatgsi_crawl_active_pages', 'Live page counters of the running crawl.'));
		for (const a of active) {
			out.push(line('chatgsi_crawl_active', { source: a.slug, mode: a.mode }, 1));
			out.push(line('chatgsi_crawl_active_elapsed_seconds', { source: a.slug }, a.elapsed));
			out.push(line('chatgsi_crawl_heartbeat_age_seconds', { source: a.slug }, a.heartbeat_age));
			out.push(line('chatgsi_crawl_active_pages', { source: a.slug, outcome: 'seen' }, a.seen));
			out.push(line('chatgsi_crawl_active_pages', { source: a.slug, outcome: 'changed' }, a.changed));
			out.push(line('chatgsi_crawl_active_pages', { source: a.slug, outcome: 'not_fetched' }, a.unfetched));
			out.push(line('chatgsi_crawl_active_pages', { source: a.slug, outcome: 'failed' }, a.failed));
		}

		// Control state, so the dashboard shows what the admin UI last asked for.
		out.push(...head('chatgsi_crawl_paused', '1 when an admin has paused this source.'));
		out.push(...head('chatgsi_crawl_stop_pending', '1 when a stop has been requested and not yet acknowledged.'));
		out.push(
			...head('chatgsi_crawl_interval_minutes', 'Configured automatic interval. Absent means no schedule.')
		);
		out.push(...head('chatgsi_crawl_due_in_seconds', 'Seconds until the next scheduled run. Negative means overdue.'));
		for (const c of control) {
			out.push(line('chatgsi_crawl_paused', { source: c.slug }, c.desired_state === 'paused' ? 1 : 0));
			out.push(line('chatgsi_crawl_stop_pending', { source: c.slug }, c.stop_pending ? 1 : 0));
			if (c.interval_minutes !== null) {
				out.push(line('chatgsi_crawl_interval_minutes', { source: c.slug, mode: c.mode }, c.interval_minutes));
			}
			if (c.due_in !== null) out.push(line('chatgsi_crawl_due_in_seconds', { source: c.slug }, c.due_in));
		}

		out.push(...head('chatgsi_crawl_queue_depth', 'Crawl requests queued and not yet claimed.'));
		out.push(
			...head(
				'chatgsi_crawl_queue_oldest_seconds',
				'Age of the oldest unclaimed request. Growing without bound means `crawler tick` is not running.'
			)
		);
		for (const q of queue) {
			out.push(line('chatgsi_crawl_queue_depth', { source: q.slug }, q.pending));
			out.push(line('chatgsi_crawl_queue_oldest_seconds', { source: q.slug }, q.oldest ?? 0));
		}

		return out;
	})
};

// --- vector database --------------------------------------------------------

/**
 * pgvector and the corpus behind retrieval.
 *
 * `embedded` versus `all` is the number that matters: a chunk with no embedding
 * is invisible to dense search, so a persistent gap means retrieval is quietly
 * running at reduced recall with no error anywhere.
 */
const vectors: Collector = {
	name: 'vectors',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const [totals, sizes, perKb, indexes] = await Promise.all([
			sql<
				{
					chunks: number;
					embedded: number;
					documents: number;
					deleted_documents: number;
					tokens: string;
					avg_tokens: number | null;
					avg_chunks_per_doc: number | null;
				}[]
			>`
				SELECT (SELECT count(*) FROM chunks)::int AS chunks,
				       (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL)::int AS embedded,
				       (SELECT count(*) FROM documents WHERE deleted_at IS NULL)::int AS documents,
				       (SELECT count(*) FROM documents WHERE deleted_at IS NOT NULL)::int
				         AS deleted_documents,
				       (SELECT coalesce(sum(token_count), 0) FROM chunks)::text AS tokens,
				       (SELECT avg(token_count) FROM chunks)::float AS avg_tokens,
				       (SELECT avg(n) FROM (SELECT count(*) AS n FROM chunks
				                             GROUP BY document_id) c)::float
				         AS avg_chunks_per_doc`,
			// Table sizes, so "the database is growing" can be attributed. Chunks
			// dominate: 4096 float4 per embedding is ~16 KB before TOAST.
			sql<{ relname: string; bytes: string; toast: string; indexes: string }[]>`
				SELECT c.relname,
				       pg_table_size(c.oid)::text AS bytes,
				       coalesce(pg_total_relation_size(c.reltoastrelid), 0)::text AS toast,
				       pg_indexes_size(c.oid)::text AS indexes
				  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				 WHERE n.nspname = 'public' AND c.relkind = 'r'
				   AND c.relname IN ('chunks','documents','messages','conversations',
				                     'attachments','generated_files','external_cache',
				                     'crawl_runs','audit_log')`,
			sql<{ label: string; chunks: number; documents: number }[]>`
				SELECT kb.label,
				       count(c.id)::int AS chunks,
				       count(DISTINCT d.id)::int AS documents
				  FROM knowledge_bases kb
				  LEFT JOIN documents d ON d.kb_id = kb.id AND d.deleted_at IS NULL
				  LEFT JOIN chunks c ON c.document_id = d.id
				 GROUP BY kb.label`,
			// Is the ANN index built? Retrieval does an exact scan until it is,
			// which is correct but gets slower as the corpus grows (003_indexes).
			sql<{ indexname: string; bytes: string }[]>`
				SELECT indexname, pg_relation_size(indexname::regclass)::text AS bytes
				  FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'chunks'`
		]);

		const t = totals[0];
		const out = [
			...up('vectors', true),
			...head('chatgsi_vector_chunks', 'Chunks in the index, total and with an embedding.'),
			line('chatgsi_vector_chunks', { state: 'all' }, t.chunks),
			line('chatgsi_vector_chunks', { state: 'embedded' }, t.embedded),
			line('chatgsi_vector_chunks', { state: 'unembedded' }, t.chunks - t.embedded),
			...head('chatgsi_vector_documents', 'Documents backing the index, live and swept.'),
			line('chatgsi_vector_documents', { state: 'live' }, t.documents),
			line('chatgsi_vector_documents', { state: 'deleted' }, t.deleted_documents),
			...head('chatgsi_vector_tokens', 'Total tokens across all chunks.'),
			line('chatgsi_vector_tokens', {}, Number(t.tokens)),
			...head('chatgsi_vector_chunk_tokens_avg', 'Mean tokens per chunk. Target is CHUNK_TARGET_TOKENS (512).'),
			line('chatgsi_vector_chunk_tokens_avg', {}, t.avg_tokens ?? 0),
			...head('chatgsi_vector_chunks_per_document_avg', 'Mean chunks per document.'),
			line('chatgsi_vector_chunks_per_document_avg', {}, t.avg_chunks_per_doc ?? 0),
			...head('chatgsi_vector_dimensions', 'Embedding width. Qwen3-Embedding-8B is 4096.'),
			line('chatgsi_vector_dimensions', {}, 4096)
		];

		out.push(...head('chatgsi_table_bytes', 'Size of the tables that actually grow, by part.'));
		for (const s of sizes) {
			out.push(line('chatgsi_table_bytes', { table: s.relname, part: 'heap' }, Number(s.bytes)));
			out.push(line('chatgsi_table_bytes', { table: s.relname, part: 'toast' }, Number(s.toast)));
			out.push(line('chatgsi_table_bytes', { table: s.relname, part: 'indexes' }, Number(s.indexes)));
		}

		out.push(...head('chatgsi_index_bytes', 'Indexes on the chunks table, including the ANN index once built.'));
		for (const i of indexes) out.push(line('chatgsi_index_bytes', { index: i.indexname }, Number(i.bytes)));
		out.push(
			...head(
				'chatgsi_vector_ann_index_present',
				'1 once the HNSW index from 003_indexes.sql exists. Until then dense search is an exact scan: correct, but linear in corpus size.'
			)
		);
		out.push(
			line(
				'chatgsi_vector_ann_index_present',
				{},
				indexes.some((i) => i.indexname.includes('ann')) ? 1 : 0
			)
		);

		out.push(...head('chatgsi_knowledge_base_chunks', 'Chunks per knowledge base.'));
		out.push(...head('chatgsi_knowledge_base_documents', 'Documents per knowledge base.'));
		for (const k of perKb) {
			out.push(line('chatgsi_knowledge_base_chunks', { kb: k.label }, k.chunks));
			out.push(line('chatgsi_knowledge_base_documents', { kb: k.label }, k.documents));
		}

		return out;
	})
};

// --- users, activity, and the shape of what they store ----------------------

const activity: Collector = {
	name: 'activity',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const [active, convos, files, sizes] = await Promise.all([
			// DAU / WAU / MAU from last_seen_at, which hooks.server.ts refreshes on
			// every authenticated request.
			sql<{ dau: number; wau: number; mau: number; new_7d: number }[]>`
				SELECT count(*) FILTER (WHERE last_seen_at > now() - interval '1 day')::int AS dau,
				       count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')::int AS wau,
				       count(*) FILTER (WHERE last_seen_at > now() - interval '30 days')::int AS mau,
				       count(*) FILTER (WHERE first_seen_at > now() - interval '7 days')::int AS new_7d
				  FROM app_users`,
			sql<
				{
					conversations: number;
					messages: number;
					msgs_per_convo: number | null;
					active_1d: number;
					active_7d: number;
					with_feedback: number;
				}[]
			>`
				SELECT (SELECT count(*) FROM conversations)::int AS conversations,
				       (SELECT count(*) FROM messages)::int AS messages,
				       (SELECT avg(n) FROM (SELECT count(*) AS n FROM messages
				                             GROUP BY conversation_id) m)::float
				         AS msgs_per_convo,
				       (SELECT count(*) FROM conversations
				         WHERE updated_at > now() - interval '1 day')::int AS active_1d,
				       (SELECT count(*) FROM conversations
				         WHERE updated_at > now() - interval '7 days')::int AS active_7d,
				       (SELECT count(DISTINCT message_id) FROM feedback)::int AS with_feedback`,
			sql<
				{
					kind: string;
					files: number;
					bytes: string;
					avg_bytes: number | null;
					max_bytes: string;
					owners: number;
				}[]
			>`
				SELECT 'upload' AS kind, count(*)::int AS files,
				       coalesce(sum(bytes), 0)::text AS bytes, avg(bytes)::float AS avg_bytes,
				       coalesce(max(bytes), 0)::text AS max_bytes,
				       count(DISTINCT user_sub)::int AS owners
				  FROM attachments
				UNION ALL
				SELECT 'generated', count(*)::int, coalesce(sum(bytes), 0)::text,
				       avg(bytes)::float, coalesce(max(bytes), 0)::text,
				       count(DISTINCT user_sub)::int
				  FROM generated_files`,
			// Attachments by mime, so "uploaded files metrics" is more than a total.
			sql<{ mime: string; files: number; bytes: string }[]>`
				SELECT mime, count(*)::int AS files, sum(bytes)::text AS bytes
				  FROM attachments GROUP BY mime`
		]);

		const a = active[0];
		const c = convos[0];
		const out = [
			...up('activity', true),
			...head(
				'chatgsi_active_users',
				'Distinct users seen in the window. Sourced from app_users.last_seen_at, refreshed on every authenticated request.'
			),
			line('chatgsi_active_users', { window: '1d' }, a.dau),
			line('chatgsi_active_users', { window: '7d' }, a.wau),
			line('chatgsi_active_users', { window: '30d' }, a.mau),
			...head('chatgsi_new_users_7d', 'Users who logged in for the first time in the last week.'),
			line('chatgsi_new_users_7d', {}, a.new_7d),
			...head('chatgsi_active_conversations', 'Conversations touched in the window.'),
			line('chatgsi_active_conversations', { window: '1d' }, c.active_1d),
			line('chatgsi_active_conversations', { window: '7d' }, c.active_7d),
			...head('chatgsi_messages_per_conversation_avg', 'Mean messages per conversation.'),
			line('chatgsi_messages_per_conversation_avg', {}, c.msgs_per_convo ?? 0),
			...head('chatgsi_messages_with_feedback', 'Messages that have been rated at least once.'),
			line('chatgsi_messages_with_feedback', {}, c.with_feedback)
		];

		out.push(...head('chatgsi_file_bytes', 'Bytes stored per file kind.'));
		out.push(...head('chatgsi_file_count', 'Files stored per kind.'));
		out.push(...head('chatgsi_file_bytes_avg', 'Mean file size per kind.'));
		out.push(...head('chatgsi_file_bytes_max', 'Largest single file per kind.'));
		out.push(...head('chatgsi_file_owners', 'Distinct users who own at least one file of this kind.'));
		for (const f of files) {
			out.push(line('chatgsi_file_bytes', { kind: f.kind }, Number(f.bytes)));
			out.push(line('chatgsi_file_count', { kind: f.kind }, f.files));
			out.push(line('chatgsi_file_bytes_avg', { kind: f.kind }, f.avg_bytes ?? 0));
			out.push(line('chatgsi_file_bytes_max', { kind: f.kind }, Number(f.max_bytes)));
			out.push(line('chatgsi_file_owners', { kind: f.kind }, f.owners));
		}

		out.push(...head('chatgsi_upload_bytes_by_mime', 'Attachment bytes by content type.'));
		out.push(...head('chatgsi_upload_files_by_mime', 'Attachment count by content type.'));
		for (const m of sizes) {
			out.push(line('chatgsi_upload_bytes_by_mime', { mime: m.mime }, Number(m.bytes)));
			out.push(line('chatgsi_upload_files_by_mime', { mime: m.mime }, m.files));
		}

		return out;
	})
};

// --- external document cache ------------------------------------------------

/**
 * The 7-day cache of external documents (migration 014).
 *
 * These objects belong to no user and are deliberately outside the quota
 * accounting, which means they are also invisible on the storage dashboard's
 * per-user panels — this is the only place their size shows up. Expired-but-not-
 * swept entries are counted separately, because they occupy disk while serving
 * nobody.
 */
const externalCache: Collector = {
	name: 'external_cache',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const [rows, byMime] = await Promise.all([
			sql<
				{
					entries: number;
					bytes: string;
					fresh: number;
					fresh_bytes: string;
					expired: number;
					expired_bytes: string;
					avg_bytes: number | null;
					oldest: number | null;
					newest: number | null;
				}[]
			>`
				SELECT count(*)::int AS entries,
				       coalesce(sum(bytes), 0)::text AS bytes,
				       count(*) FILTER (WHERE fetched_at > now() - interval '7 days')::int AS fresh,
				       coalesce(sum(bytes) FILTER (
				         WHERE fetched_at > now() - interval '7 days'), 0)::text AS fresh_bytes,
				       count(*) FILTER (WHERE fetched_at <= now() - interval '7 days')::int
				         AS expired,
				       coalesce(sum(bytes) FILTER (
				         WHERE fetched_at <= now() - interval '7 days'), 0)::text
				         AS expired_bytes,
				       avg(bytes)::float AS avg_bytes,
				       extract(epoch FROM now() - min(fetched_at))::float AS oldest,
				       extract(epoch FROM now() - max(fetched_at))::float AS newest
				  FROM external_cache`,
			sql<{ mime: string; entries: number; bytes: string }[]>`
				SELECT mime, count(*)::int AS entries, sum(bytes)::text AS bytes
				  FROM external_cache GROUP BY mime`
		]);

		const r = rows[0];
		const out = [
			...up('external_cache', true),
			...head('chatgsi_cache_entries', 'Entries in the external document cache, by freshness.'),
			line('chatgsi_cache_entries', { state: 'fresh' }, r.fresh),
			line('chatgsi_cache_entries', { state: 'expired' }, r.expired),
			...head(
				'chatgsi_cache_bytes',
				'Bytes held by the external cache. Outside user quota by design (migration 014), so this is the only place it is counted.'
			),
			line('chatgsi_cache_bytes', { state: 'fresh' }, Number(r.fresh_bytes)),
			line('chatgsi_cache_bytes', { state: 'expired' }, Number(r.expired_bytes)),
			line('chatgsi_cache_bytes', { state: 'total' }, Number(r.bytes)),
			...head('chatgsi_cache_entry_bytes_avg', 'Mean size of a cached document.'),
			line('chatgsi_cache_entry_bytes_avg', {}, r.avg_bytes ?? 0),
			...head('chatgsi_cache_age_seconds', 'Age of the oldest and newest cache entries.'),
			line('chatgsi_cache_age_seconds', { which: 'oldest' }, r.oldest ?? 0),
			line('chatgsi_cache_age_seconds', { which: 'newest' }, r.newest ?? 0)
		];

		out.push(...head('chatgsi_cache_bytes_by_mime', 'Cached bytes by content type.'));
		out.push(...head('chatgsi_cache_entries_by_mime', 'Cached entries by content type.'));
		for (const m of byMime) {
			out.push(line('chatgsi_cache_bytes_by_mime', { mime: m.mime }, Number(m.bytes)));
			out.push(line('chatgsi_cache_entries_by_mime', { mime: m.mime }, m.entries));
		}

		return out;
	})
};

// --- SeaweedFS --------------------------------------------------------------

interface DataNode {
	Url?: string;
	PublicUrl?: string;
	Volumes?: number;
	Max?: number;
	VolumeIds?: string;
}

interface MasterStatus {
	Version?: string;
	Topology?: {
		Max?: number;
		Free?: number;
		DataCenters?: {
			Id?: string;
			Racks?: { Id?: string; DataNodes?: DataNode[] }[];
		}[];
	};
}

interface VolumeStatus {
	Version?: string;
	DiskStatuses?: { dir?: string; all?: number; used?: number; free?: number }[];
	Volumes?: {
		Id?: number;
		Size?: number;
		FileCount?: number;
		DeleteCount?: number;
		DeletedByteCount?: number;
		ReadOnly?: boolean;
	}[];
}

/**
 * Object storage: how much of the 25 TB is gone.
 *
 * Discovery goes through the master's topology rather than a configured list of
 * volume servers, so scaling the StatefulSet
 * (`kubectl -n chat-gsi scale statefulset/seaweed-volume --replicas=3`) shows up
 * on the dashboard without touching any config. The addresses in the topology
 * are the ones the volume servers registered with — the same ones the filer
 * dials — so if they resolve for SeaweedFS they resolve for us.
 *
 * `chatgsi_object_storage_capacity_bytes` is CONFIGURED (S3_CAPACITY_BYTES), not
 * measured. The lab node does not have 25 TB attached; the number is the target
 * the deployment is sized against, and the dashboard's headline gauge is usage
 * against that target. The physically available bytes are reported separately as
 * chatgsi_seaweed_disk_bytes, and the two are shown side by side precisely so
 * "we are at 3% of plan but the actual disk is full" cannot hide.
 */
const seaweed: Collector = {
	name: 'seaweed',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const timeout = config.metrics.timeoutMs;
		const master = await getJson<MasterStatus>(`${config.s3.masterUrl}/dir/status`, timeout);

		const nodes: DataNode[] = (master.Topology?.DataCenters ?? []).flatMap((dc) =>
			(dc.Racks ?? []).flatMap((rack) => rack.DataNodes ?? [])
		);

		const out = [
			...up('seaweed', true),
			...head('chatgsi_seaweed_volume_servers', 'Volume servers registered with the master.'),
			line('chatgsi_seaweed_volume_servers', {}, nodes.length),
			...head('chatgsi_seaweed_volume_slots', 'Volume slots across the cluster, by state.'),
			line('chatgsi_seaweed_volume_slots', { state: 'max' }, master.Topology?.Max ?? 0),
			line('chatgsi_seaweed_volume_slots', { state: 'free' }, master.Topology?.Free ?? 0)
		];

		// One unreachable volume server must not lose the numbers from the others:
		// with three replicas, a rolling restart would otherwise blank the graph.
		const statuses = await Promise.all(
			nodes.map(async (node) => {
				const address = node.PublicUrl || node.Url;
				if (!address) return null;
				const url = address.startsWith('http') ? address : `http://${address}`;
				try {
					return { address, status: await getJson<VolumeStatus>(`${url}/status`, timeout) };
				} catch {
					return { address, status: null };
				}
			})
		);

		let storedBytes = 0;
		let fileCount = 0;
		let deletedBytes = 0;
		let diskAll = 0;
		let diskUsed = 0;
		let diskFree = 0;

		const perNode: string[] = [];
		for (const entry of statuses) {
			if (!entry) continue;
			if (!entry.status) {
				perNode.push(line('chatgsi_seaweed_node_up', { node: entry.address }, 0));
				continue;
			}
			perNode.push(line('chatgsi_seaweed_node_up', { node: entry.address }, 1));

			let nodeBytes = 0;
			for (const v of entry.status.Volumes ?? []) {
				nodeBytes += v.Size ?? 0;
				fileCount += v.FileCount ?? 0;
				deletedBytes += v.DeletedByteCount ?? 0;
			}
			storedBytes += nodeBytes;
			perNode.push(line('chatgsi_seaweed_node_stored_bytes', { node: entry.address }, nodeBytes));
			perNode.push(
				line(
					'chatgsi_seaweed_node_volumes',
					{ node: entry.address },
					(entry.status.Volumes ?? []).length
				)
			);

			for (const disk of entry.status.DiskStatuses ?? []) {
				diskAll += disk.all ?? 0;
				diskUsed += disk.used ?? 0;
				diskFree += disk.free ?? 0;
			}
		}

		out.push(
			...head('chatgsi_seaweed_node_up', '1 when a volume server answered /status this scrape.'),
			...head('chatgsi_seaweed_node_stored_bytes', 'Bytes held by one volume server.'),
			...head('chatgsi_seaweed_node_volumes', 'Volumes hosted by one volume server.'),
			...perNode,
			...head(
				'chatgsi_object_storage_used_bytes',
				'Bytes SeaweedFS actually holds, summed over every volume.'
			),
			line('chatgsi_object_storage_used_bytes', {}, storedBytes),
			...head(
				'chatgsi_object_storage_capacity_bytes',
				'Planned object-storage capacity (S3_CAPACITY_BYTES). Configured, not measured.'
			),
			line('chatgsi_object_storage_capacity_bytes', {}, config.s3.capacityBytes),
			...head(
				'chatgsi_object_storage_reclaimable_bytes',
				'Bytes belonging to deleted needles, recovered by a volume compaction.'
			),
			line('chatgsi_object_storage_reclaimable_bytes', {}, deletedBytes),
			...head('chatgsi_object_storage_objects', 'Needles stored across the cluster.'),
			line('chatgsi_object_storage_objects', {}, fileCount),
			...head(
				'chatgsi_seaweed_disk_bytes',
				'The filesystem under the volume servers, as SeaweedFS sees it.'
			),
			line('chatgsi_seaweed_disk_bytes', { state: 'all' }, diskAll),
			line('chatgsi_seaweed_disk_bytes', { state: 'used' }, diskUsed),
			line('chatgsi_seaweed_disk_bytes', { state: 'free' }, diskFree)
		);

		return out;
	})
};

// --- Valkey -----------------------------------------------------------------

/**
 * Sessions and cache health, from Valkey's own INFO.
 *
 * Session counting uses SCAN, not KEYS: KEYS is O(n) and blocks the server, and
 * this runs every scrape. At lab scale either would do; the habit is worth more
 * than the microseconds.
 */
const valkey: Collector = {
	name: 'valkey',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const [sessions, info] = await Promise.all([sessionCount(), valkeyInfo()]);

		const numeric = (key: string) => {
			const value = info[key];
			const parsed = value === undefined ? NaN : Number(value);
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const hits = numeric('keyspace_hits');
		const misses = numeric('keyspace_misses');

		return [
			...up('valkey', true),
			...head('chatgsi_active_sessions', 'Live sessions (sess:* keys in Valkey).'),
			line('chatgsi_active_sessions', { kind: 'session' }, sessions.sessions),
			line('chatgsi_active_sessions', { kind: 'pending_auth' }, sessions.pending),
			...head('chatgsi_valkey_memory_bytes', 'Valkey memory, used and peak.'),
			line('chatgsi_valkey_memory_bytes', { state: 'used' }, numeric('used_memory')),
			line('chatgsi_valkey_memory_bytes', { state: 'peak' }, numeric('used_memory_peak')),
			...head('chatgsi_valkey_connected_clients', 'Clients connected to Valkey.'),
			line('chatgsi_valkey_connected_clients', {}, numeric('connected_clients')),
			...head('chatgsi_valkey_keyspace_total', 'Keyspace lookups, by result.', 'counter'),
			line('chatgsi_valkey_keyspace_total', { result: 'hit' }, hits),
			line('chatgsi_valkey_keyspace_total', { result: 'miss' }, misses),
			...head('chatgsi_valkey_commands_total', 'Commands processed by Valkey.', 'counter'),
			line('chatgsi_valkey_commands_total', {}, numeric('total_commands_processed')),
			...head('chatgsi_valkey_uptime_seconds', 'Valkey uptime.'),
			line('chatgsi_valkey_uptime_seconds', {}, numeric('uptime_in_seconds'))
		];
	})
};

// --- Keycloak ---------------------------------------------------------------

/**
 * Keycloak liveness only.
 *
 * Its own /metrics is on the management port and is off unless KC_METRICS_ENABLED
 * is set; more to the point, Keycloak here is `start-dev` with an H2 database
 * that dies with the pod (AGENTS.md §6), so JVM and datastore metrics from it
 * describe something that is not intended to persist. Whether login works is the
 * fact worth graphing, and that is what this reports.
 */
const keycloak: Collector = {
	name: 'keycloak',
	collect: cached(config.metrics.dbCacheMs, async () => {
		const started = Date.now();
		let ready = 0;
		try {
			const res = await withTimeout(config.metrics.timeoutMs, (signal) =>
				fetch(`${config.keycloak.managementUrl}/health/ready`, { signal })
			);
			const body = (await res.json()) as { status?: string };
			ready = res.ok && body.status === 'UP' ? 1 : 0;
		} catch {
			ready = 0;
		}

		return [
			...up('keycloak', true),
			...head('chatgsi_keycloak_ready', '1 when Keycloak reports /health/ready UP.'),
			line('chatgsi_keycloak_ready', {}, ready),
			...head('chatgsi_keycloak_probe_duration_seconds', 'Time for the readiness probe above.'),
			line('chatgsi_keycloak_probe_duration_seconds', {}, (Date.now() - started) / 1000),
			...head(
				'chatgsi_keycloak_directory_configured',
				'1 when the read-only admin service account is configured.'
			),
			line(
				'chatgsi_keycloak_directory_configured',
				{},
				config.keycloak.adminClientId && config.keycloak.adminClientSecret ? 1 : 0
			)
		];
	})
};

// --- registration -----------------------------------------------------------

let registered = false;

/** Idempotent: the module may be imported from more than one entry point. */
export function registerCollectors(): void {
	if (registered) return;
	registered = true;
	startLagSampler();
	registry.collector(runtime);
	registry.collector(postgres);
	registry.collector(crawler);
	registry.collector(vectors);
	registry.collector(activity);
	registry.collector(externalCache);
	registry.collector(seaweed);
	registry.collector(valkey);
	registry.collector(keycloak);
}
