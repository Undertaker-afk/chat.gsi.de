/**
 * Search indico.gsi.de.
 *
 * Indico is where GSI's talks, workshops and collaboration meetings live, and
 * the slides attached to them answer questions the wiki never covers -- project
 * status, who runs what, the design of a detector. None of it is in our corpus,
 * because none of it is linked from a crawlable page.
 *
 * Two APIs exist and this uses the newer one. `docs.getindico.io`'s HTTP API
 * (`/export/event/<id>.json`) is a fine EXPORT interface -- verified working
 * anonymously against event 13799 -- but it has no full-text search: you must
 * already know the event id. `/search/api/search` is what the site's own search
 * box calls, and it is what makes this an agent rather than a link follower.
 *
 * Verified against indico.gsi.de on 2026-07-30:
 *
 *   * `type` is REQUIRED. Omitting it is a 422 with an HTML body, not a JSON
 *     error, so a caller that forgets it gets a parse failure and no clue why.
 *   * Useful types are `attachment`, `event` and `event_note`. `contribution`
 *     and `subcontribution` are accepted but return zero results for every
 *     query tried (FIDIUM, LHCb, CBM) -- they are not indexed on this instance.
 *     Do not "fix" their absence by adding them back; they cost a request and
 *     return nothing.
 *   * `total` is `-1`, meaning "not counted". It is not a result count and must
 *     never be rendered as one.
 *   * `pagenav.next` is an OPAQUE cursor, passed back as `page=`. It is not a
 *     page number: `page=1` is a 422.
 *
 * Anonymous search sees only what an anonymous browser sees. Protected events
 * are absent from the results rather than returned and refused later, which is
 * the same arrangement the wiki crawler relies on (AGENTS.md §12): anonymity is
 * the access-control mechanism, so there is nothing here to leak.
 */
import { metrics } from '../metrics';

const BASE = 'https://indico.gsi.de';

/** Only the types that actually return results on this instance. */
export type IndicoType = 'attachment' | 'event' | 'event_note';

export interface IndicoHit {
	kind: IndicoType;
	/** Absolute URL. The API returns paths. */
	url: string;
	title: string;
	/** "FSD weekly meeting › CBM", for a human and for the model. */
	context: string;
	/** ISO date, when the API gave one. */
	date: string | null;
	/** Attachments only: the stored filename, which carries the file type. */
	filename?: string;
}

interface RawResult {
	type?: string;
	title?: string;
	filename?: string;
	url?: string;
	modified_dt?: string;
	start_dt?: string;
	event_path?: { title?: string }[];
	category_path?: { title?: string }[];
}

/**
 * One search against one type.
 *
 * Failures return an empty list rather than throwing. This agent runs on every
 * turn, and indico.gsi.de being slow or down must degrade the answer, never fail
 * it -- the corpus is still there.
 */
async function searchType(
	query: string,
	type: IndicoType,
	limit: number,
	signal: AbortSignal
): Promise<IndicoHit[]> {
	const url =
		`${BASE}/search/api/search?q=${encodeURIComponent(query)}` + `&type=${encodeURIComponent(type)}`;

	let payload: { results?: RawResult[] };
	try {
		const response = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
		});
		if (!response.ok) {
			metrics.externalSearches.inc({ source: 'indico', outcome: `http_${response.status}` });
			return [];
		}
		payload = await response.json();
	} catch {
		metrics.externalSearches.inc({ source: 'indico', outcome: 'error' });
		return [];
	}

	const results = Array.isArray(payload.results) ? payload.results : [];
	metrics.externalSearches.inc({ source: 'indico', outcome: 'ok' });
	metrics.externalHits.inc({ source: 'indico' }, results.length);

	return results.slice(0, limit).flatMap((raw) => {
		if (!raw.url) return [];
		const event = raw.event_path?.map((p) => p.title).filter(Boolean) ?? [];
		const category = raw.category_path?.map((p) => p.title).filter(Boolean) ?? [];
		// Home is the root of every category path and says nothing.
		const trail = [...event, ...category.filter((t) => t !== 'Home')];

		return [
			{
				kind: type,
				url: new URL(raw.url, BASE).toString(),
				title: (raw.title || raw.filename || raw.url).trim(),
				context: trail.join(' › '),
				date: raw.modified_dt ?? raw.start_dt ?? null,
				filename: raw.filename
			}
		];
	});
}

/**
 * Search Indico for material relevant to `query`.
 *
 * Attachments first and weighted heaviest: a slide deck is the thing with an
 * answer in it, while an event record is a title and a date. Events are still
 * searched because they give the model somewhere to point when no file matched.
 */
export async function searchIndico(
	query: string,
	limit: number,
	signal: AbortSignal
): Promise<IndicoHit[]> {
	const [attachments, events] = await Promise.all([
		searchType(query, 'attachment', limit, signal),
		searchType(query, 'event', Math.max(2, Math.floor(limit / 3)), signal)
	]);

	return [...attachments, ...events].slice(0, limit);
}
