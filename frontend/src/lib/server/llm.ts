/**
 * Single point of contact with the GSI LLM proxy.
 *
 * Everything the server sends to a model goes through here, so moving from the
 * praktikum proxy to the real llmbot.gsi.de is a change to LLM_BASE_URL and
 * nothing else. The API key never leaves this process.
 */
import { config } from './config';
import { metrics } from './metrics';

export type Role = 'system' | 'user' | 'assistant';

export interface TextPart {
	type: 'text';
	text: string;
}
export interface ImagePart {
	type: 'image_url';
	image_url: { url: string };
}
export interface Message {
	role: Role;
	content: string | (TextPart | ImagePart)[];
}

interface CompleteOptions {
	model?: string;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	/** Ask for a JSON object back. Used by the planner and subagents. */
	json?: boolean;
}

/**
 * Every call to the proxy is counted here, which is the whole reason this file
 * is the single point of contact. `endpoint` is the path template and `model`
 * comes from configuration, so neither can grow cardinality at runtime.
 *
 * Failures are labelled by HTTP status, or `network` when no response arrived at
 * all — on this proxy those are genuinely different problems (a 403 is the wrong
 * path prefix, a network error is the gateway being unreachable), and telling
 * them apart from a graph has already saved an afternoon once.
 */
async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(`${config.llm.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.llm.apiKey}`,
				'Content-Type': 'application/json',
				// The proxy advertises a Content-Encoding it does not actually apply, so a
				// client offering compression fails to decode the body. Verified 2026-07-27.
				'Accept-Encoding': 'identity'
			},
			body: JSON.stringify(body),
			signal
		});
	} catch (err) {
		metrics.llmErrors.inc({ endpoint: path, status: signal?.aborted ? 'aborted' : 'network' });
		throw err;
	}
	if (!res.ok) {
		metrics.llmErrors.inc({ endpoint: path, status: res.status });
		const detail = await res.text().catch(() => '');
		throw new Error(`LLM ${path} failed: ${res.status} ${detail.slice(0, 300)}`);
	}
	return res;
}

/** Token accounting, when the proxy bothers to report it. Missing usage is not
 *  an error -- it just means that turn contributes nothing to the token graph. */
function countUsage(model: string, usage: unknown): void {
	const u = usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
	if (u?.prompt_tokens) metrics.llmTokens.inc({ model, direction: 'prompt' }, u.prompt_tokens);
	if (u?.completion_tokens) {
		metrics.llmTokens.inc({ model, direction: 'completion' }, u.completion_tokens);
	}
}

export async function complete(messages: Message[], opts: CompleteOptions = {}): Promise<string> {
	const model = opts.model ?? config.llm.chatModel;
	const started = process.hrtime.bigint();
	try {
		const res = await post(
			'/chat/completions',
			{
				model,
				messages,
				max_tokens: opts.maxTokens ?? 2048,
				temperature: opts.temperature ?? 0.2,
				...(opts.json ? { response_format: { type: 'json_object' } } : {})
			},
			opts.signal
		);
		const data = await res.json();
		countUsage(model, data.usage);
		metrics.llmRequests.inc({ endpoint: 'complete', model, outcome: 'ok' });
		return data.choices?.[0]?.message?.content ?? '';
	} catch (err) {
		metrics.llmRequests.inc({
			endpoint: 'complete',
			model,
			outcome: opts.signal?.aborted ? 'aborted' : 'error'
		});
		throw err;
	} finally {
		metrics.llmDuration.observe(
			{ endpoint: 'complete', model },
			Number(process.hrtime.bigint() - started) / 1e9
		);
	}
}

/**
 * Streaming completion, yielding token deltas.
 *
 * Two separate timings are recorded, because for a streamed answer they mean
 * different things to a user: time-to-first-token is how long the page sits
 * blank, and total duration is how long the answer takes to finish arriving.
 * A proxy under load usually degrades the first while leaving the second
 * roughly intact, and averaging them together hides that entirely.
 *
 * The instrumentation lives in a `finally` around the generator body, so a
 * consumer that breaks out of the loop early — a user navigating away
 * mid-answer — still records the attempt rather than leaking a series that
 * never closes.
 */
export async function* stream(
	messages: Message[],
	opts: CompleteOptions = {}
): AsyncGenerator<string> {
	const model = opts.model ?? config.llm.chatModel;
	const started = process.hrtime.bigint();
	const elapsed = () => Number(process.hrtime.bigint() - started) / 1e9;
	let first = true;
	let outcome = 'ok';

	try {
		const res = await post(
			'/chat/completions',
			{
				model,
				messages,
				max_tokens: opts.maxTokens ?? 2048,
				temperature: opts.temperature ?? 0.2,
				stream: true
			},
			opts.signal
		);
		if (!res.body) return;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// SSE frames are separated by a blank line; a frame may span reads.
			const frames = buffer.split('\n\n');
			buffer = frames.pop() ?? '';

			for (const frame of frames) {
				for (const line of frame.split('\n')) {
					if (!line.startsWith('data:')) continue;
					const payload = line.slice(5).trim();
					if (payload === '[DONE]') return;
					try {
						const parsed = JSON.parse(payload);
						// Some proxies attach usage to the final chunk only.
						countUsage(model, parsed.usage);
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) {
							if (first) {
								first = false;
								metrics.llmTimeToFirstToken.observe({ model }, elapsed());
							}
							yield delta;
						}
					} catch {
						// Ignore keep-alives and any non-JSON frame.
					}
				}
			}
		}
	} catch (err) {
		outcome = opts.signal?.aborted ? 'aborted' : 'error';
		throw err;
	} finally {
		metrics.llmRequests.inc({ endpoint: 'stream', model, outcome });
		metrics.llmDuration.observe({ endpoint: 'stream', model }, elapsed());
	}
}

/**
 * Parse a JSON object out of a model response, tolerating prose or code fences
 * around it. Returns null rather than throwing -- callers degrade gracefully.
 */
export function parseJson<T>(raw: string): T | null {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = (fenced ? fenced[1] : raw).trim();
	try {
		return JSON.parse(candidate) as T;
	} catch {
		const start = candidate.indexOf('{');
		const end = candidate.lastIndexOf('}');
		if (start === -1 || end <= start) return null;
		try {
			return JSON.parse(candidate.slice(start, end + 1)) as T;
		} catch {
			return null;
		}
	}
}
