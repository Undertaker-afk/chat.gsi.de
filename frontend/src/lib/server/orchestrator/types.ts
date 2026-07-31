import type { RetrievedChunk } from '../retrieval';

export type Mode = 'fast' | 'deep';

/** Events streamed to the browser over SSE. See plan.md §7. */
export type OrchestratorEvent =
	| { type: 'status'; phase: 'planning' | 'retrieving' | 'reading' | 'writing'; round: number }
	| {
			type: 'agent';
			id: string;
			query: string;
			state: 'running' | 'done' | 'failed';
			findings?: number;
	  }
	| { type: 'token'; text: string }
	/**
	 * The image subagent. `none` is a real outcome, not a failure: the judge is
	 * told to reject a set of candidates that does not show what was asked about.
	 */
	| {
			type: 'image';
			state: 'searching' | 'found' | 'none';
			query: string;
			title?: string;
			credit?: string | null;
			url?: string;
			permalink?: string;
			candidates?: number;
			/** Set only when the library search had to be broadened to find anything. */
			effectiveQuery?: string;
	  }
	/**
	 * The documents agent. Runs on every turn, so `none` is by far the most
	 * common terminal state and is not a failure -- most questions are answered
	 * by the documentation alone.
	 */
	| {
			type: 'documents';
			state: 'searching' | 'found' | 'none';
			/** How many candidates the searches returned, before triage. */
			searched?: number;
			/** How many were actually downloaded and read. */
			read?: number;
			sources?: {
				/**
				 * The citation marker this source was given. Carried here, not
				 * recomputed on reload: it is the only field that has to match the
				 * [n] the answer text was written against, and deriving it from a
				 * count breaks the moment a corpus chunk is swept.
				 */
				marker: number;
				origin: 'indico' | 'repository' | 'corpus-link';
				url: string;
				title: string;
				context: string;
				read: boolean;
			}[];
	  }
	/**
	 * A source outside the corpus, emitted alongside the chunk citations so the
	 * client renders one list. `chunkId` is absent because there is no chunk --
	 * that is the distinguishing field, not a missing one.
	 */
	| {
			type: 'citation';
			marker: number;
			chunkId?: number;
			external?: {
				origin: 'indico' | 'repository' | 'corpus-link';
				/** False when only metadata was available; see docsagent.ts. */
				read: boolean;
			};
			url: string;
			title: string;
			heading: string;
			score: number;
			fetchedAt: string;
	  }
	| { type: 'suggestions'; items: string[] }
	| { type: 'done'; usage: Usage; partial: boolean }

export interface Usage {
	rounds: number;
	subagents: number;
	chunks: number;
	elapsedMs: number;
}

export interface Finding {
	agentId: string;
	query: string;
	summary: string;
	/** Citation markers this finding relies on, into the shared pool. */
	markers: number[];
	confidence: 'high' | 'medium' | 'low';
}

/**
 * Shared, deduplicated citation pool.
 *
 * Subagents run in parallel and routinely retrieve the same chunk. Without a
 * shared pool the same source would appear as [2], [7] and [11] in one answer.
 */
export class CitationPool {
	private readonly byChunk = new Map<number, number>();
	readonly entries: RetrievedChunk[] = [];

	/** Returns the 1-based marker for a chunk, assigning one if new. */
	add(chunk: RetrievedChunk): number {
		const existing = this.byChunk.get(chunk.chunkId);
		if (existing !== undefined) return existing;
		const marker = this.entries.length + 1;
		this.byChunk.set(chunk.chunkId, marker);
		this.entries.push(chunk);
		return marker;
	}

	get(marker: number): RetrievedChunk | undefined {
		return this.entries[marker - 1];
	}

	get size(): number {
		return this.entries.length;
	}
}
