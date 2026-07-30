import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { fetchImage, getRecord } from '$lib/server/media';
import { cachedDocument } from '$lib/server/externalcache';

/**
 * Serves one Media Library image by record id.
 *
 * Answers embed `/api/media/30763`, never the origin URL, for two reasons:
 *
 *   1. media-images.gsi.de signs every URL with an expiring per-variant token,
 *      so an answer that stored one would show a broken image a few days later.
 *      A record id does not expire.
 *   2. The browser would have to reach media-images.gsi.de directly, which is a
 *      third-party request from the chat page for something the server can just
 *      hand over.
 *
 * Cached for CACHE_TTL_DAYS under the record's permalink. On a miss the record
 * page is re-read to mint a fresh token -- that is the whole point of keying on
 * the id rather than the URL.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');

	const id = params.id;
	if (!/^\d{1,9}$/.test(id)) error(400, 'ungültige Medien-ID');

	// Resolved before the cache lookup so the key is the record's own permalink
	// rather than something we invented. One extra HTML fetch per image, against
	// a token that would otherwise be stale.
	//
	// null means "no picture" and nothing more precise: the library answers 500
	// for an unknown id, so it cannot be told apart from an outage (see
	// getRecord). 404 is the honest response to the browser either way.
	const record = await getRecord(id);
	if (!record) error(404, 'Bild nicht gefunden');

	const image = await cachedDocument(record.permalink, async () => {
		try {
			return await fetchImage(record.imageUrl);
		} catch (e) {
			error(502, `Bild konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
		}
	});

	return new Response(image.bytes, {
		headers: {
			'content-type': image.mime,
			'content-length': String(image.bytes.byteLength),
			// Public upstream, but this response sits behind a session.
			'cache-control': 'private, max-age=86400',
			'x-content-type-options': 'nosniff',
			'x-cache': image.hit ? 'HIT' : 'MISS'
		}
	});
};
