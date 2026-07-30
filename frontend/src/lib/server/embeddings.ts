/**
 * Qwen3-Embedding-8B access.
 *
 * The model is ASYMMETRIC: queries carry an instruction prefix, documents do not.
 * Mixing this up degrades recall silently -- no error, just worse answers -- so the
 * prefix is defined once, here, and the two directions are separate functions.
 * The crawler owns the document side; this file is the query side.
 */
import { config } from './config';
import { metrics } from './metrics';

const QUERY_INSTRUCTION =
	'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

export const EMBEDDING_DIM = 4096;

/**
 * `direction` is a metrics label as well as a correctness concern: because the
 * model is asymmetric, a query embedded as a document silently ruins recall.
 * Having the two counted separately means the ratio is visible -- a burst of
 * document embeddings from the app rather than the crawler is a bug worth
 * seeing, not a mystery in the retrieval quality numbers.
 */
async function embed(
	inputs: string[],
	direction: 'query' | 'document',
	signal?: AbortSignal
): Promise<number[][]> {
	const started = process.hrtime.bigint();
	try {
		const res = await fetch(`${config.llm.baseUrl}/embeddings`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.llm.apiKey}`,
				'Content-Type': 'application/json',
				// See llm.ts -- the proxy mislabels Content-Encoding.
				'Accept-Encoding': 'identity'
			},
			body: JSON.stringify({ model: config.llm.embeddingModel, input: inputs }),
			signal
		});
		if (!res.ok) {
			metrics.llmErrors.inc({ endpoint: '/embeddings', status: res.status });
			throw new Error(`embeddings failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
		}
		const data = (await res.json()).data as { index: number; embedding: number[] }[];
		metrics.embeddingRequests.inc({ outcome: 'ok' });
		metrics.embeddingInputs.inc({ direction }, inputs.length);
		// Response order is not guaranteed to match input order.
		return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
	} catch (err) {
		metrics.embeddingRequests.inc({ outcome: signal?.aborted ? 'aborted' : 'error' });
		throw err;
	} finally {
		metrics.embeddingDuration.observe(
			{ direction },
			Number(process.hrtime.bigint() - started) / 1e9
		);
	}
}

/** Embed a user query. Applies the instruction prefix. */
export async function embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
	const [vector] = await embed([QUERY_INSTRUCTION + query], 'query', signal);
	return vector;
}

/** Embed document text. No prefix -- must match how the crawler embedded it. */
export async function embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> {
	return embed(texts, 'document', signal);
}

/** pgvector literal for parameterised SQL. */
export function toVector(values: number[]): string {
	return `[${values.join(',')}]`;
}
