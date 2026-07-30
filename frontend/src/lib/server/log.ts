/**
 * Structured logging.
 *
 * Every line is one JSON object on stdout. Promtail ships stdout to Loki
 * verbatim and Loki parses it with `| json`, so a field written here is a field
 * you can filter and graph on in Grafana without a regex.
 *
 * Why JSON and not the prettier text format: a log line is only useful in an
 * incident if you can ask questions of it. `{level="error"} | json | route="/api/chat"`
 * is a question. A grep over free-form prose is a guess.
 *
 * The rules, because they are easy to break by accident:
 *
 *   - NO secrets, tokens, or message content. Loki is behind the same
 *     llmbot-admin gate as Grafana, but a chat corpus is not a log.
 *   - Field names stay stable. A dashboard query is code that depends on them.
 *   - Bounded value spaces where a field is used as a Loki label; unbounded
 *     values (urls, ids) are fine inside the JSON body, which is not indexed.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Read once, at module load rather than per call: this sits on the request path
 * and $env/dynamic lookups are not free.
 */
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
const pretty = process.env.LOG_FORMAT === 'text';

export interface Fields {
	[key: string]: unknown;
}

function emit(level: Level, message: string, fields: Fields = {}): void {
	if (LEVELS[level] < threshold) return;

	if (pretty) {
		// Development only. `npm run dev` in a terminal is the one place where a
		// human is reading these directly and JSON is the wrong shape.
		const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
		console.log(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extra}`);
		return;
	}

	// An Error does not survive JSON.stringify -- it serialises to {}. Unpacked
	// here rather than at every call site, because the one time it matters is the
	// one time somebody forgot.
	const out: Fields = { ts: new Date().toISOString(), level, msg: message, ...fields };
	if (fields.err instanceof Error) {
		out.err = fields.err.message;
		out.err_type = fields.err.name;
		if (level === 'error') out.stack = fields.err.stack;
	}

	// console.log, not process.stdout.write: adapter-node's stdout is a stream
	// that can block, and console handles the partial-write case for us.
	console.log(JSON.stringify(out));
}

export const log = {
	debug: (message: string, fields?: Fields) => emit('debug', message, fields),
	info: (message: string, fields?: Fields) => emit('info', message, fields),
	warn: (message: string, fields?: Fields) => emit('warn', message, fields),
	error: (message: string, fields?: Fields) => emit('error', message, fields)
};

/**
 * Routes deliberately excluded from the access log.
 *
 * /metrics is scraped every 15 seconds and /health every 10 by two probes. Left
 * in, they would be ~20k lines a day of "a robot checked and everything was
 * fine" — enough to bury real traffic and to dominate Loki's retention. Their
 * failures are already visible: the scrape target going down IS the signal.
 */
const QUIET = new Set(['/metrics', '/health']);

/** One line per request. The backbone of the Logs dashboard. */
export function accessLog(entry: {
	route: string;
	method: string;
	path: string;
	status: number;
	durationMs: number;
	user?: string;
	referer?: string | null;
}): void {
	if (QUIET.has(entry.path)) return;
	// 4xx is the caller's problem and 5xx is ours; logging both at `info` would
	// make `{level="error"}` useless as a first look during an incident.
	const level: Level = entry.status >= 500 ? 'error' : entry.status >= 400 ? 'warn' : 'info';
	emit(level, 'request', {
		kind: 'access',
		route: entry.route,
		method: entry.method,
		path: entry.path,
		status: entry.status,
		duration_ms: Math.round(entry.durationMs),
		user: entry.user
	});
}
