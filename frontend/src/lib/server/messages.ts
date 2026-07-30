/**
 * Shaping a stored message for the client.
 *
 * Shared because it was duplicated, and the duplicate had already drifted: the
 * conversation route rebuilt the agent trace, the chosen image and the follow-up
 * suggestions, while the branch route returned none of them -- so switching to
 * an older version of a question silently stripped its trace. Adding the
 * documents agent made that worse rather than causing it.
 *
 * One function, both routes.
 */
import type { AttachedFile } from './generated';

/** A message row as `conversationPath` returns it. */
interface MessageRow {
	id: string;
	parent_id: string | null;
	role: string;
	content: string;
	images?: string[] | null;
	version?: number;
	versions?: number;
	siblingIds?: string[];
	citations: Citation[];
	trace?: unknown;
}

interface Citation {
	marker: number;
	url: string;
	title: string;
	heading: string;
	chunkId?: number;
	external?: { origin: string; read: boolean };
}

interface TraceEvent {
	type: string;
	[key: string]: unknown;
}

function events(trace: unknown): TraceEvent[] {
	return (trace as { events?: TraceEvent[] } | null)?.events ?? [];
}

/** Replay the stored agent events so a reloaded deep answer keeps its trace. */
function extractAgents(trace: unknown) {
	const byId = new Map<string, Record<string, unknown>>();
	for (const event of events(trace)) {
		if (event.type !== 'agent') continue;
		const step = event as unknown as { id: string };
		byId.set(step.id, { ...(byId.get(step.id) ?? {}), ...step });
	}
	return [...byId.values()];
}

/**
 * The last event of a kind wins.
 *
 * `searching` is always followed by `found` or `none`, and only the outcome is
 * worth showing on a finished answer.
 */
function lastOfType(trace: unknown, type: string) {
	return events(trace).filter((e) => e.type === type).at(-1) ?? undefined;
}

/** Follow-up buttons, so reopening a conversation does not lose them. */
function extractSuggestions(trace: unknown): string[] {
	const event = lastOfType(trace, 'suggestions') as { items?: string[] } | undefined;
	return Array.isArray(event?.items) ? event.items : [];
}

/**
 * Citations for sources outside the corpus, rebuilt from the trace.
 *
 * They cannot come from the `citations` table: its `chunk_id` is a foreign key
 * into `chunks`, and an Indico PDF has no chunk. The marker travels with each
 * source rather than being recomputed, so the numbering matches the text the
 * answer was written against even if a corpus chunk has since been swept.
 */
function externalCitations(trace: unknown): Citation[] {
	const documents = lastOfType(trace, 'documents') as
		| {
				sources?: {
					marker: number;
					origin: string;
					url: string;
					title: string;
					context: string;
					read: boolean;
				}[];
		  }
		| undefined;

	return (documents?.sources ?? []).map((source) => ({
		marker: source.marker,
		url: source.url,
		title: source.title,
		heading: source.context,
		external: { origin: source.origin, read: source.read }
	}));
}

/**
 * The client-facing shape of one message.
 *
 * `attached` is optional because the branch route does not load generated-file
 * attachments; everything derived from the trace is unconditional, because a
 * message that loses its trace on reload looks like a bug to a user and is one.
 */
export function serialiseMessage(row: MessageRow, attached?: AttachedFile[]) {
	return {
		id: row.id,
		parentId: row.parent_id,
		role: row.role,
		content: row.content,
		images: row.images ?? [],
		files: attached ?? [],
		version: row.version,
		versions: row.versions,
		siblingIds: row.siblingIds,
		citations: [...row.citations, ...externalCitations(row.trace)],
		agents: extractAgents(row.trace),
		image: lastOfType(row.trace, 'image'),
		documents: lastOfType(row.trace, 'documents'),
		suggestions: extractSuggestions(row.trace)
	};
}
