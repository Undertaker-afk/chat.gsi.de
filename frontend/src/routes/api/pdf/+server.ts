import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { assertFetchable, ScopeError } from '$lib/server/pdfscope';
import { follow, mimeOf, readCapped, MAX_DOCUMENT_BYTES } from '$lib/server/fetchdoc';
import { EXTRACTABLE } from '$lib/server/sources/extract';
import { cachedDocument } from '$lib/server/externalcache';

/**
 * Streams a cited document so the in-page viewer can render it.
 *
 * Named /api/pdf for historical reasons -- it started as a PDF-only proxy. It now
 * also serves the Office formats the documents agent reads (pptx, docx, xlsx and
 * their OpenDocument equivalents), because Indico is mostly slide decks and a
 * reader who is shown one as a source should be able to open it.
 *
 * Why a proxy at all: the PDFs cited in answers live on www.gsi.de, on
 * indico.gsi.de and on the conference hosts GSI publishes to, none of which send
 * `Access-Control-*` headers. pdf.js fetches the bytes with XHR, so a direct
 * cross-origin load is blocked by the browser and the viewer shows nothing.
 * Fetching server-side sidesteps CORS entirely.
 *
 * This is an outbound fetcher driven by a URL in the query string, so it is
 * locked down accordingly:
 *   * session required -- not an open relay for anonymous callers;
 *   * the URL must be under gsi.de or linked from a crawled document
 *     ($lib/server/pdfscope);
 *   * redirects are followed by hand so every hop can be re-checked, and no hop
 *     may resolve to an internal address ($lib/server/fetchdoc);
 *   * the response must actually be a PDF, and is capped.
 *
 * The fetching itself lives in $lib/server/fetchdoc because the documents agent
 * needs the identical boundary. Two copies of this would drift.
 */
export const GET: RequestHandler = async ({ url, locals, fetch }) => {
	if (!locals.user) error(401, 'unauthenticated');

	const target = url.searchParams.get('url');
	if (!target) error(400, 'url ist erforderlich');

	try {
		const start = await assertFetchable(target);

		// Cached in object storage for CACHE_TTL_DAYS. The fetcher below runs only
		// on a miss, and every validation stays inside it -- nothing reaches
		// storage that has not already been checked.
		const document = await cachedDocument(start.toString(), async () => {
			const upstream = await follow(start, fetch);

			const type = mimeOf(upstream);
			// PDFs and Office documents only. The allowlist is shared with the
			// extractor so the viewer can never be handed something the agent would
			// refuse, and vice versa -- and it keeps this from becoming a general
			// relay for arbitrary content types.
			if (!EXTRACTABLE[type]) {
				// Overwhelmingly this is a 200 HTML error page from a host that has
				// reorganised its site: the link in the documentation is simply dead.
				throw new ScopeError(415, `Die Adresse liefert kein lesbares Dokument (${type || 'unbekannter Typ'}).`);
			}

			return { bytes: await readCapped(upstream, MAX_DOCUMENT_BYTES, 'Dokument'), mime: type };
		});

		return new Response(document.bytes, {
			headers: {
				'content-type': document.mime,
				'content-length': String(document.bytes.byteLength),
				// The upstream document is public, but this response is behind a
				// session, so it stays out of shared caches.
				'cache-control': 'private, max-age=300',
				'content-disposition': 'inline',
				'x-content-type-options': 'nosniff',
				'x-cache': document.hit ? 'HIT' : 'MISS'
			}
		});
	} catch (e) {
		if (e instanceof ScopeError) error(e.status, e.message);
		throw e;
	}
};
