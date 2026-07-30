/**
 * Read-only client for the GSI Media Library (media.gsi.de).
 *
 * Deliberately NOT crawled into the corpus: the library holds around 60000
 * images, and indexing them would cost far more than it returns. It is queried
 * live instead, on the rare turn where a picture is actually the answer.
 *
 * There is no JSON API, so this parses the two pages the site renders:
 *
 *   /medialibrary?q=...            the result grid -- record ids + 640px previews
 *   /media/record/<base64>/        one record -- title, credit, date, full image
 *
 * The record page carries a `var overlayContent = {...}` blob with everything,
 * which is far more stable to read than the surrounding markup.
 *
 * IMPORTANT: every image URL the site hands out is signed with a per-variant
 * `token` and expires (verified 2026-07-29: stripping the token gives 404). So
 * a URL must never be stored in an answer -- answers reference our own
 * /api/media/<id>, which re-resolves the record at read time.
 */
import { in_scope_media } from './mediascope';

const BASE = 'https://media.gsi.de';
const FETCH_TIMEOUT_MS = 15_000;

export interface MediaHit {
	/** Record number, e.g. 30763. Stable, and what an answer refers to. */
	id: string;
	/** `record:///default/default/1/30763`, needed to rebuild the record URL. */
	uri: string;
	/** 640px preview, already signed. Short-lived -- use it now, never store it. */
	previewUrl: string;
}

export interface MediaRecord {
	id: string;
	title: string;
	/** Credit line the site requires be shown, e.g. "GSI/FAIR". */
	copyright: string | null;
	date: string | null;
	categories: string[];
	/** Public page for this record, safe to link from an answer. */
	permalink: string;
	/** 640px signed image. Short-lived. */
	imageUrl: string;
	mime: string;
}

async function get(url: string): Promise<string> {
	// Both hosts are under gsi.de, but the check is explicit rather than assumed:
	// this module builds URLs from parsed HTML, and parsed HTML is untrusted input.
	if (!in_scope_media(url)) throw new Error(`out of scope: ${url}`);

	const response = await fetch(url, {
		redirect: 'follow',
		headers: { accept: 'text/html' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!response.ok) throw new Error(`media.gsi.de responded ${response.status}`);
	return response.text();
}

/** `&amp;` in an href is markup, not part of the URL. */
const unescapeHtml = (s: string) =>
	s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');

export interface SearchResult {
	hits: MediaHit[];
	/** The query that actually produced them -- see searchMedia on broadening. */
	effectiveQuery: string;
	broadened: boolean;
}

/**
 * Free-text search, broadening the query until it returns something.
 *
 * The library ANDs every term, and it bites hard (measured 2026-07-29):
 *
 *     FAIR Baustelle Bauphase Luftaufnahme      0
 *     FAIR Baustelle Bauphase                   2
 *     FAIR Baustelle Luftaufnahme             297
 *     FAIR Baustelle                         1006
 *
 * One extra adjective is the difference between 297 results and none, so a
 * perfectly reasonable four-word query silently finds nothing. Asking the
 * planner for fewer words helps but cannot be relied on -- it is a judgement
 * call made without knowing the corpus.
 *
 * So terms are dropped from the END, most specific first, until there are hits.
 * The narrowest level that matched is used first and broader levels only top up
 * a thin pool, which keeps the most on-target pictures at the front. The
 * original query still goes to the vision judge, so broadening the search never
 * broadens what counts as a good answer.
 */
export async function searchMedia(query: string, limit = 6): Promise<SearchResult> {
	const terms = query.trim().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return { hits: [], effectiveQuery: query, broadened: false };

	// Never below two terms: a single word like "FAIR" matches 2276 records and
	// says nothing about what was wanted.
	const floor = Math.min(2, terms.length);
	const hits: MediaHit[] = [];
	const seen = new Set<string>();
	let effectiveQuery = query;
	let broadened = false;

	for (let n = terms.length; n >= floor; n--) {
		const attempt = terms.slice(0, n).join(' ');
		const found = await searchOnce(attempt, limit);
		if (found.length > 0 && hits.length === 0) {
			effectiveQuery = attempt;
			broadened = n < terms.length;
		}
		for (const hit of found) {
			if (seen.has(hit.id)) continue;
			seen.add(hit.id);
			hits.push(hit);
		}
		if (hits.length >= limit) break;
	}

	return { hits: hits.slice(0, limit), effectiveQuery, broadened };
}

/**
 * One request.
 *
 * `filters[search_type]=record` matches what the site's own form submits; without
 * it the endpoint searches collections instead of individual images.
 */
async function searchOnce(query: string, limit: number): Promise<MediaHit[]> {
	const url = new URL('/medialibrary', BASE);
	url.searchParams.set('q', query);
	url.searchParams.set('filters[search_type]', 'record');
	// Photographs only. The library also holds 102 videos and 13 documents, and
	// their tiles look exactly like an image's -- a video is represented by a
	// poster frame. Without this the judge sees that frame, quite reasonably
	// picks it, and the answer ends up illustrated with a still from a trailer
	// presented as a photograph (observed with record 27757, "FAIR-Trailer").
	url.searchParams.set('filters[type0][_doctype][0]', 'type=image');
	url.searchParams.set('current_page', '1');
	url.searchParams.set('page_size', '25');

	const html = await get(url.toString());
	const hits: MediaHit[] = [];

	// One <li data-item-id="record:///..."> per tile. Split rather than match the
	// whole element: the tiles contain nested markup that a single regex would
	// have to guess the end of.
	const tiles = html.split(/<li[^>]*data-item-id="record:\/\/\//i).slice(1);
	for (const tile of tiles) {
		const path = tile.match(/^([^"]+)"/);
		if (!path) continue;
		const id = path[1].split('/').pop();
		if (!id || !/^\d+$/.test(id)) continue;

		const preview = tile.match(/https:\/\/media-images\.gsi\.de\/[^"')\s]+/);
		if (!preview) continue;

		hits.push({
			id,
			uri: `record:///${path[1]}`,
			previewUrl: unescapeHtml(preview[0])
		});
		if (hits.length >= limit) break;
	}

	return hits;
}

/** How many records the library holds for this query, for the trace line. */
export function totalFromSearch(html: string): number | null {
	const match = html.match(/class="media-counter"[\s\S]{0,200}?class="number">\s*(\d+)/i);
	return match ? Number(match[1]) : null;
}

/**
 * Extract a balanced `{...}` starting at `from`.
 *
 * A non-greedy /\{[\s\S]*?\};/ is the obvious approach and is wrong: the blob
 * contains `};` inside string values, so it truncates to invalid JSON. This
 * walks the braces and skips over string literals.
 */
function balancedObject(source: string, from: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = from; i < source.length; i++) {
		const c = source[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return source.slice(from, i + 1);
	}
	return null;
}

interface OverlayField {
	id: string;
	label: string;
	values: { value: string }[];
}

/**
 * Full metadata for one record id, or null when there is no usable record.
 *
 * Null covers "no such record" AND "the library would not serve it", because
 * the site does not distinguish them: an id that does not exist comes back as
 * **500**, not 404 (verified 2026-07-29). Callers therefore cannot read null as
 * "the service is up and the record is missing" -- only as "no picture".
 */
export async function getRecord(id: string, uri?: string): Promise<MediaRecord | null> {
	if (!/^\d+$/.test(id)) return null;

	// The site addresses a record by a base64 of this shape. `d` and the two
	// "default"s are the instance/model the public library runs under; they come
	// from the search result's uri when we have it.
	const parts = uri?.replace('record:///', '').split('/') ?? [];
	const descriptor = {
		i: parts[0] || 'default',
		m: parts[1] || 'default',
		d: Number(parts[2] || 1),
		r: Number(id)
	};
	const hash = Buffer.from(JSON.stringify(descriptor)).toString('base64');

	let html: string;
	try {
		html = await get(`${BASE}/media/record/${hash}/`);
	} catch {
		return null;
	}

	const marker = html.indexOf('var overlayContent');
	if (marker === -1) return null;
	const start = html.indexOf('{', marker);
	if (start === -1) return null;
	const blob = balancedObject(html, start);
	if (!blob) return null;

	let resource: Record<string, unknown>;
	try {
		resource = (JSON.parse(blob) as { resource: Record<string, unknown> }).resource;
	} catch {
		return null;
	}
	if (!resource) return null;

	const fields = (resource.fields as OverlayField[] | undefined) ?? [];
	const field = (name: string) =>
		fields
			.find((f) => f.id === name)
			?.values.map((v) => v.value.replace(/,\s*$/, '').trim())
			.filter(Boolean) ?? [];

	// `thumbnail` is 640x360 -- the same pixels as the grid preview at a smaller
	// file size (29 kB vs 42 kB). `media` is the 4000px original, far too heavy to
	// put inline in a chat answer.
	const imageUrl = String(resource.thumbnail ?? resource.media ?? '');
	if (!imageUrl || !in_scope_media(imageUrl)) return null;

	return {
		id,
		title: String(resource.title ?? field('title')[0] ?? `Bild ${id}`).trim(),
		copyright: field('CreditCopyright')[0] ?? null,
		date: field('Date')[0] ?? null,
		categories: [...field('MainCategories'), ...field('SubCategories')],
		permalink: String(resource.sharedLink ?? `${BASE}/media/record/${hash}/`),
		imageUrl,
		mime: String(resource.mime ?? 'image/jpeg')
	};
}

/** Fetch image bytes from the signed URL the site just gave us. */
export async function fetchImage(
	url: string
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
	if (!in_scope_media(url)) throw new Error('image URL out of scope');

	const response = await fetch(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!response.ok) throw new Error(`image responded ${response.status}`);

	const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	// An expired token returns a 200 HTML error page, so the type is the check
	// that matters, not the status.
	if (!mime.startsWith('image/')) throw new Error(`not an image (${mime || 'unknown'})`);

	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('image too large');
	return { bytes, mime };
}

/** Data URL for the vision model. Previews are ~40 kB, so this stays small. */
export async function asDataUrl(url: string): Promise<string> {
	const { bytes, mime } = await fetchImage(url);
	return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
