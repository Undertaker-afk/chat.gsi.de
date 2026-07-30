/**
 * The metrics facade. Import from `$lib/server/metrics`, never from the files
 * behind it — that keeps the "one registry, one endpoint" rule enforceable by
 * grep rather than by convention.
 *
 * Usage:
 *
 *   import { metrics } from '$lib/server/metrics';
 *   metrics.s3Operations.inc({ operation: 'put', outcome: 'ok' });
 *   await metrics.s3Duration.time({ operation: 'put' }, () => send(...));
 */
import { registry } from './registry';
import { registerCollectors } from './collectors';
import * as declared from './metrics';
import { config } from '../config';

export * from './registry';
export const metrics = declared;

let ready = false;

/**
 * Wire up the scrape-time collectors and the build-info metric.
 *
 * Called by the /metrics endpoint rather than at module load: SvelteKit imports
 * server modules during `vite build`, where starting timers and reading config
 * would be both useless and fatal — the same reason config.ts uses lazy getters.
 */
export function initMetrics(): void {
	if (ready) return;
	ready = true;
	declared.buildInfo.set({ version: config.metrics.version, node: process.version }, 1);
	registerCollectors();
}

/** The whole exposition, application counters and collected backends together. */
export async function renderMetrics(): Promise<string> {
	initMetrics();
	return registry.render();
}

/**
 * Time an async operation into a histogram and count its outcome, which is the
 * shape almost every call site wants. `classify` turns a thrown error into a
 * bounded label — the default keeps it to ok|error, because an unbounded error
 * message as a label value is how a metrics endpoint becomes a memory leak.
 */
export async function observe<T>(
	labels: Record<string, string | number>,
	histogram: { observe(l: Record<string, string | number>, v: number): void },
	counter: { inc(l: Record<string, string | number>, n?: number): void },
	fn: () => Promise<T>,
	classify: (err: unknown) => string = () => 'error'
): Promise<T> {
	const started = process.hrtime.bigint();
	try {
		const result = await fn();
		counter.inc({ ...labels, outcome: 'ok' });
		return result;
	} catch (err) {
		counter.inc({ ...labels, outcome: classify(err) });
		throw err;
	} finally {
		histogram.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
	}
}
