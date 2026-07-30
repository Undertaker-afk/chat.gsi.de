/**
 * Hybrid retrieval: dense (HNSW cosine) + lexical (tsvector), fused with
 * Reciprocal Rank Fusion.
 *
 * Dense retrieval alone reliably misses exact identifiers -- hostnames, sbatch
 * flags, error strings -- which is a large share of what people actually ask at
 * GSI. RRF fixes that for the cost of one extra SQL query and no extra model.
 */
import { sql } from './db';
import { embedQuery, toVector } from './embeddings';
import { config } from './config';
import { metrics } from './metrics';

export interface RetrievedChunk {
	chunkId: number;
	documentId: number;
	url: string;
	title: string;
	headingPath: string[];
	anchor: string | null;
	text: string;
	fetchedAt: Date;
	score: number;
}

const RRF_K = 60;

export async function retrieve(
	query: string,
	opts: { topK?: number; limit?: number; signal?: AbortSignal; kbIds?: number[] } = {}
): Promise<RetrievedChunk[]> {
	const topK = opts.topK ?? config.orchestrator.retrieveTopK;
	const limit = opts.limit ?? config.orchestrator.contextChunksFast;

	// Access control (plan.md §8b). A HARD filter on both arms, not a post-filter:
	// a chunk the caller may not see never enters the ranking, so it cannot shift
	// the results or leak through a citation. `undefined` means "no restriction"
	// (internal callers such as the crawler); an empty list means "nothing", which
	// is a real state -- a user with no grants gets no sources rather than all.
	const kbIds = opts.kbIds;
	if (kbIds && kbIds.length === 0) return [];
	const kbFilter = kbIds ? sql`AND d.kb_id = ANY(${kbIds})` : sql``;

	// Timed as one unit, embedding included: from the orchestrator's point of view
	// "retrieval" is the whole hop, and the embedding call is the part most likely
	// to be the slow half. The embedding time is also recorded on its own as
	// chatgsi_embedding_duration_seconds, so the split is recoverable.
	const started = process.hrtime.bigint();

	const vector = toVector(await embedQuery(query, opts.signal));

	const [dense, lexical] = await Promise.all([
		sql<Row[]>`
			SELECT c.id, c.document_id, c.heading_path, c.anchor, c.text,
			       d.url, d.title, d.fetched_at
			  FROM chunks c
			  JOIN documents d ON d.id = c.document_id
			 WHERE d.deleted_at IS NULL AND c.embedding IS NOT NULL ${kbFilter}
			 ORDER BY c.embedding <=> ${vector}::vector
			 LIMIT ${topK}`,
		sql<Row[]>`
			SELECT c.id, c.document_id, c.heading_path, c.anchor, c.text,
			       d.url, d.title, d.fetched_at
			  FROM chunks c
			  JOIN documents d ON d.id = c.document_id
			 WHERE d.deleted_at IS NULL ${kbFilter}
			   AND c.tsv @@ plainto_tsquery('simple', ${query})
			 ORDER BY ts_rank_cd(c.tsv, plainto_tsquery('simple', ${query})) DESC
			 LIMIT ${topK}`
	]);

	const fused = fuse([dense, lexical]).slice(0, limit);
	metrics.retrievalDuration.observe({}, Number(process.hrtime.bigint() - started) / 1e9);
	metrics.retrievalChunks.observe({}, fused.length);
	return fused;
}

interface Row {
	id: number;
	document_id: number;
	heading_path: string[];
	anchor: string | null;
	text: string;
	url: string;
	title: string;
	fetched_at: Date;
}

/** Reciprocal Rank Fusion: score = Σ 1/(k + rank). Rank-based, so the two
 *  lists' incomparable score scales never have to be normalised. */
function fuse(lists: Row[][]): RetrievedChunk[] {
	const scores = new Map<number, number>();
	const rows = new Map<number, Row>();

	for (const list of lists) {
		list.forEach((row, index) => {
			scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (RRF_K + index + 1));
			rows.set(row.id, row);
		});
	}

	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([id, score]) => {
			const row = rows.get(id)!;
			return {
				chunkId: row.id,
				documentId: row.document_id,
				url: row.url,
				title: row.title,
				headingPath: row.heading_path ?? [],
				anchor: row.anchor,
				text: row.text,
				fetchedAt: row.fetched_at,
				score
			};
		});
}

/** Render chunks as numbered context for a prompt. Markers are 1-based and
 *  match the [n] the user sees. */
export function formatContext(chunks: RetrievedChunk[]): string {
	return chunks
		.map((c, i) => {
			const path = c.headingPath.length ? ` › ${c.headingPath.join(' › ')}` : '';
			return `[${i + 1}] ${c.title}${path}\nSource: ${c.url}${c.anchor ?? ''}\n\n${c.text}`;
		})
		.join('\n\n---\n\n');
}
