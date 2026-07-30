/**
 * Seven-day cache for external documents fetched on a user's behalf.
 *
 * www.gsi.de PDFs are public, immutable in practice, and re-fetched every time
 * somebody opens the same citation. Caching them in SeaweedFS means the second
 * reader is served from the lab rather than from the public website.
 *
 * These objects belong to no user and are deliberately NOT counted in
 * storage.usage() -- see the note in db/migrations/014.
 */
import { createHash } from 'node:crypto';
import { sql } from './db';
import { deleteObject, ensureBucketOnce, getObject, putObject } from './s3';
import { metrics } from './metrics';

export const CACHE_TTL_DAYS = 7;

const keyFor = (url: string) => createHash('sha256').update(url).digest('hex');

export interface CachedDocument {
	// Uint8Array<ArrayBuffer>, not the default Uint8Array<ArrayBufferLike>: the
	// latter could be backed by a SharedArrayBuffer, which is not a valid
	// Response body. Both producers below construct a fresh, owned buffer.
	bytes: Uint8Array<ArrayBuffer>;
	mime: string;
	/** True when this response came from storage rather than the origin. */
	hit: boolean;
}

/** A fresh cache entry, or null when absent or past its TTL. */
async function lookup(url: string): Promise<CachedDocument | null> {
	const hash = keyFor(url);
	const [row] = await sql<{ object_key: string; mime: string }[]>`
		SELECT object_key, mime
		  FROM external_cache
		 WHERE url_hash = ${hash}
		   AND fetched_at > now() - ${CACHE_TTL_DAYS} * interval '1 day'`;
	if (!row) return null;

	const object = await getObject(row.object_key);
	if (!object) {
		// Row without bytes: the object was swept or never landed. Drop the row so
		// the next call re-fetches instead of failing forever.
		await sql`DELETE FROM external_cache WHERE url_hash = ${hash}`;
		return null;
	}
	return { bytes: new Uint8Array(object.body), mime: row.mime, hit: true };
}

async function store(url: string, bytes: Uint8Array, mime: string): Promise<void> {
	const hash = keyFor(url);
	const key = `cache/external/${hash}`;

	await ensureBucketOnce();
	await putObject(key, Buffer.from(bytes), mime);

	await sql`
		INSERT INTO external_cache (url_hash, url, mime, bytes, object_key)
		VALUES (${hash}, ${url}, ${mime}, ${bytes.byteLength}, ${key})
		ON CONFLICT (url_hash) DO UPDATE SET
			mime       = EXCLUDED.mime,
			bytes      = EXCLUDED.bytes,
			object_key = EXCLUDED.object_key,
			fetched_at = now()`;
}

/**
 * Serve `url` from cache, or fetch it with `fetcher` and cache the result.
 *
 * `fetcher` does the scope checking and validation -- this module only decides
 * whether the network is needed at all, and never chooses a URL itself.
 */
export async function cachedDocument(
	url: string,
	fetcher: () => Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }>
): Promise<CachedDocument> {
	// `result` is the metric label for the whole call, and the three values are
	// genuinely different outcomes rather than shades of one: `hit` is bandwidth
	// www.gsi.de did not have to serve, `miss` is a normal first read, and `error`
	// is the cache being broken while the document still gets served. Collapsing
	// error into miss would hide a dead cache behind a healthy-looking hit rate.
	const started = process.hrtime.bigint();
	const elapsed = () => Number(process.hrtime.bigint() - started) / 1e9;
	let result = 'miss';

	try {
		const hit = await lookup(url);
		if (hit) {
			metrics.cacheRequests.inc({ result: 'hit' });
			metrics.cacheBytes.inc({ result: 'hit' }, hit.bytes.byteLength);
			metrics.cacheFetchDuration.observe({ result: 'hit' }, elapsed());
			return hit;
		}
	} catch {
		// A cache failure must not take the document down with it; fall through to
		// the origin and try to repopulate on the way back.
		result = 'error';
	}

	const fresh = await fetcher();
	// Best effort: a storage failure means the next reader pays for a refetch,
	// which is strictly better than failing this one.
	await store(url, fresh.bytes, fresh.mime).catch(() => {});
	metrics.cacheRequests.inc({ result });
	metrics.cacheBytes.inc({ result }, fresh.bytes.byteLength);
	metrics.cacheFetchDuration.observe({ result }, elapsed());
	return { ...fresh, hit: false };
}

/**
 * Drop entries past their TTL and their objects.
 *
 * Lazy expiry already stops stale bytes being served -- lookup() filters on
 * fetched_at -- so this only reclaims space, and is safe to call at any time.
 */
export async function sweepExternalCache(): Promise<number> {
	const gone = await sql<{ object_key: string }[]>`
		DELETE FROM external_cache
		 WHERE fetched_at <= now() - ${CACHE_TTL_DAYS} * interval '1 day'
		RETURNING object_key`;
	await Promise.all(gone.map((r) => deleteObject(r.object_key).catch(() => {})));
	if (gone.length) metrics.cacheRequests.inc({ result: 'swept' }, gone.length);
	return gone.length;
}
