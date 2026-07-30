/**
 * Reading an external document: fetch it once, cache it, turn it into text.
 *
 * Everything here goes through the same two mechanisms the PDF viewer uses --
 * `pdfscope` decides whether a URL may be fetched at all, and `externalcache`
 * decides whether the network is needed. That is deliberate: the agent must not
 * be a second, weaker egress path, and a document a user opened in the viewer
 * this morning should cost the agent nothing this afternoon.
 */
import { config } from '../config';
import { sql } from '../db';
import { cachedDocument } from '../externalcache';
import { follow, mimeOf, readCapped, MAX_DOCUMENT_BYTES } from '../fetchdoc';
import { assertFetchable, ScopeError } from '../pdfscope';
import { metrics } from '../metrics';
import { EXTRACTABLE, extractDocumentText, normalise, UnreadableDocument } from './extract';

/**
 * How much extracted text one document contributes (DOCS_AGENT_MAX_TEXT_CHARS).
 *
 * A 60-page thesis is ~200k characters and would eat the whole context window on
 * its own. The first stretch of a paper or a slide deck is where the abstract,
 * the introduction and the conclusions live, which is what actually answers a
 * question -- so truncation costs far less here than the cap suggests.
 */

export interface ReadDocument {
	url: string;
	text: string;
	pages: number;
	bytes: number;
	mime: string;
	/** True when the bytes came from our cache rather than the origin. */
	cached: boolean;
	truncated: boolean;
}

/**
 * Documents linked from pages the corpus retrieval already matched.
 *
 * This is what "documents referenced inside the indexed stuff" means in
 * practice: the wiki page about the batch farm links a PDF, we crawled the page,
 * so we know about the PDF without ever having crawled it.
 *
 * Driving this from the RETRIEVED document ids rather than from a string match
 * over `document_links` matters twice over. It is more relevant -- the linking
 * page already ranked for this question -- and it is safe by construction: those
 * ids came out of a retrieval that was already filtered to the caller's
 * knowledge bases, so no permission check is needed or possible to get wrong
 * here.
 */
export async function linkedDocuments(
	documentIds: number[],
	limit: number
): Promise<{ url: string; fromTitle: string }[]> {
	if (documentIds.length === 0) return [];

	const rows = await sql<{ url: string; from_title: string }[]>`
		SELECT l.url, d.title AS from_title
		  FROM document_links l
		  JOIN documents d ON d.id = l.document_id
		 WHERE l.document_id = ANY(${documentIds})
		   AND d.deleted_at IS NULL
		   AND lower(l.url) ~ '\\.(pdf|pptx|docx|xlsx|odp|odt|ods)$'
		 ORDER BY d.title
		 LIMIT ${limit}`;

	return rows.map((r) => ({ url: r.url, fromTitle: r.from_title }));
}

/**
 * Fetch and extract one document.
 *
 * Throws `ScopeError` for anything a caller can act on -- refused, missing, not
 * a PDF -- so the agent can drop the candidate and try the next one without the
 * whole turn failing.
 */
export async function readDocument(url: string): Promise<ReadDocument> {
	const started = process.hrtime.bigint();
	const target = await assertFetchable(url);

	const document = await cachedDocument(target.toString(), async () => {
		// The global fetch, not SvelteKit's: this runs off a request path (the
		// agent is started before the response begins streaming) and the target is
		// always absolute and external, so there is nothing SvelteKit's wrapper
		// would add beyond a request-scoped lifetime we do not want here.
		const upstream = await follow(target, globalThis.fetch, 'application/pdf,application/vnd.openxmlformats-officedocument.*,*/*');
		const type = mimeOf(upstream);
		if (!EXTRACTABLE[type]) {
			// Overwhelmingly a 200 HTML page from a host that reorganised its site:
			// the link is simply dead, and that is not worth a turn.
			throw new ScopeError(415, `nicht lesbar (${type || 'unbekannter Typ'})`);
		}
		return { bytes: await readCapped(upstream, MAX_DOCUMENT_BYTES), mime: type };
	});

	let text: string;
	let pages: number;
	try {
		({ text, pages } = await extractDocumentText(document.bytes, document.mime));
	} catch (e) {
		// A scanned PDF with no text layer, a password-protected deck, a corrupt
		// file. All ordinary; none worth failing a turn over.
		metrics.documentReads.inc({ outcome: 'unreadable' });
		if (e instanceof UnreadableDocument) throw new ScopeError(422, `Text nicht extrahierbar: ${e.message}`);
		throw e;
	}

	const maxChars = config.documents.maxTextChars;
	const normalised = normalise(text);
	const truncated = normalised.length > maxChars;

	metrics.documentReads.inc({ outcome: document.hit ? 'cached' : 'fetched' });
	metrics.documentReadDuration.observe(
		{ outcome: document.hit ? 'cached' : 'fetched' },
		Number(process.hrtime.bigint() - started) / 1e9
	);
	metrics.documentPages.observe({}, pages);

	return {
		url: target.toString(),
		text: truncated ? normalised.slice(0, maxChars) : normalised,
		pages,
		bytes: document.bytes.byteLength,
		mime: document.mime,
		cached: document.hit,
		truncated
	};
}
