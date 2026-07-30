/**
 * Search repository.gsi.de, the institutional publication repository (Invenio).
 *
 * ## The constraint that shapes this whole module
 *
 * Probed 2026-07-30: `/search` and `/record/<id>` and `/record/<id>/files/*.pdf`
 * are all behind a JavaScript bot challenge. They answer 200 with a 248-byte
 * HTML stub that loads `/fast-challenge/index.js`, and that script explicitly
 * penalises automation:
 *
 *     if (navigator.webdriver) timeout_incr += 10000;
 *     if (navigator.plugins.length === 0) timeout_incr += 5000;
 *
 * A browser user never notices. A robot gets the stub, forever -- verified
 * across three retries, with and without a browser User-Agent, with and without
 * the INVENIOSESSION cookie from the homepage. `of=recjson`, `of=xm` and `of=id`
 * are all challenged too, so the documented Invenio output formats are simply
 * not reachable.
 *
 * **We do not try to defeat it.** The operator has drawn a line, and the two
 * interfaces they left open are exactly the ones meant for machines:
 *
 *   * `/rss?p=<query>`      full-text search, 200, `application/rss+xml`
 *   * `/oai2d?verb=…`       OAI-PMH, 200, Dublin Core metadata
 *
 * Both were verified working anonymously. So this module reads the front door
 * that was left open and never knocks on the one that was closed.
 *
 * ## What that costs, and why it is still worth having
 *
 * No full text, and -- verified the hard way -- **no abstracts either**. This
 * instance publishes no `dc:description` on any record sampled (183915, 368909,
 * 368907, 368893 all have zero), and `marcxml` carries no 520 summary field, so
 * there is no metadata format here that contains one. `abstract` below is
 * therefore null in practice. It is kept because the field costs nothing and
 * starts working by itself if the library ever populates it.
 *
 * What a repository result actually is, then: a bibliographic pointer. Title,
 * authors, journal or report reference, year, and a link the reader opens in a
 * browser -- where the challenge solves normally and the PDF is one click away.
 *
 * That is much weaker than Indico, where we read the slides. It is still the
 * difference between "this was published as GSI Report 2015-1, here it is" and
 * silence. Everything downstream labels it `read: false` so that nobody --
 * neither the model nor the reader -- mistakes a citation for something we read.
 */
import { metrics } from '../metrics';

const BASE = 'https://repository.gsi.de';

export interface RepositoryHit {
	/** Invenio record id, from the /record/<id> link. */
	id: string;
	url: string;
	title: string;
	date: string | null;
}

export interface RepositoryRecord extends RepositoryHit {
	authors: string[];
	/** The abstract, when the record has one. Often it does not. */
	abstract: string | null;
	/** Journal / report reference, e.g. "GSI Report 2015-1, 160-161 p. (2015)". */
	source: string | null;
}

/**
 * Minimal XML value extraction.
 *
 * These are two fixed, well-formed feeds whose fields are leaf elements holding
 * text -- no attributes to read, no nesting to walk. A parser dependency would
 * be the larger risk surface for what amounts to `<dc:title>…</dc:title>`, and
 * this matches how the S3 signer is done in this repo. It is deliberately NOT a
 * general XML parser and must not be used as one.
 */
function decode(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		// Ampersand last, or "&amp;lt;" would decode twice into a tag.
		.replace(/&amp;/g, '&')
		.trim();
}

function tagValues(xml: string, tag: string): string[] {
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
	return [...xml.matchAll(pattern)].map((m) => decode(m[1]));
}

function tagValue(xml: string, tag: string): string | null {
	return tagValues(xml, tag)[0] ?? null;
}

/** The record id out of `https://repository.gsi.de/record/183915`. */
function recordId(url: string): string | null {
	return /\/record\/(\d+)/.exec(url)?.[1] ?? null;
}

/**
 * Full-text search through the RSS interface.
 *
 * `<description>` comes back empty on this instance -- verified over 25 items --
 * so a hit is a title and a link and nothing else. `recordMetadata()` fills in
 * the rest for the few records that are worth the extra request.
 */
export async function searchRepository(
	query: string,
	limit: number,
	signal: AbortSignal
): Promise<RepositoryHit[]> {
	const url = `${BASE}/rss?p=${encodeURIComponent(query)}`;

	let xml: string;
	try {
		const response = await fetch(url, {
			headers: { accept: 'application/rss+xml,application/xml' },
			signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
		});
		if (!response.ok) {
			metrics.externalSearches.inc({ source: 'repository', outcome: `http_${response.status}` });
			return [];
		}
		xml = await response.text();
	} catch {
		metrics.externalSearches.inc({ source: 'repository', outcome: 'error' });
		return [];
	}

	// The challenge stub is HTML and ~248 bytes. If it ever starts being served
	// here too, this is where it shows up -- as a feed with no items rather than
	// as an error, which would otherwise look exactly like "no results".
	if (!xml.includes('<item>')) {
		metrics.externalSearches.inc({
			source: 'repository',
			outcome: xml.includes('fast-challenge') ? 'challenged' : 'empty'
		});
		return [];
	}

	const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
	metrics.externalSearches.inc({ source: 'repository', outcome: 'ok' });
	metrics.externalHits.inc({ source: 'repository' }, items.length);

	return items.slice(0, limit).flatMap((item) => {
		const link = tagValue(item, 'link');
		const title = tagValue(item, 'title');
		const id = link ? recordId(link) : null;
		if (!link || !title || !id) return [];

		const pubDate = tagValue(item, 'pubDate');
		const parsed = pubDate ? new Date(pubDate) : null;

		return [
			{
				id,
				url: link,
				title,
				date: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null
			}
		];
	});
}

/**
 * Bibliographic metadata for one record, over OAI-PMH.
 *
 * Costs one request per record, so the agent calls it only for the handful it
 * actually intends to cite. Returns null rather than throwing: a record without
 * an abstract is still worth citing by title.
 */
export async function recordMetadata(
	hit: RepositoryHit,
	signal: AbortSignal
): Promise<RepositoryRecord | null> {
	const url =
		`${BASE}/oai2d?verb=GetRecord&metadataPrefix=oai_dc` +
		`&identifier=oai:repository.gsi.de:${encodeURIComponent(hit.id)}`;

	let xml: string;
	try {
		const response = await fetch(url, {
			headers: { accept: 'application/xml' },
			signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
		});
		if (!response.ok) return null;
		xml = await response.text();
	} catch {
		return null;
	}

	// OAI reports "no such record" as a 200 with an <error> element, so the
	// status code alone does not tell you whether this worked.
	if (xml.includes('<error') || !xml.includes('<dc:title')) return null;

	const descriptions = tagValues(xml, 'dc:description');

	return {
		...hit,
		title: tagValue(xml, 'dc:title') ?? hit.title,
		authors: tagValues(xml, 'dc:creator').slice(0, 8),
		// Null on this instance -- see the header. Written defensively anyway:
		// where several dc:description elements exist the longest is the abstract
		// and the short ones are licence and funding boilerplate.
		abstract:
			descriptions.sort((a, b) => b.length - a.length).find((d) => d.length > 120) ?? null,
		source: tagValue(xml, 'dc:source'),
		date: tagValue(xml, 'dc:date') ?? hit.date
	};
}
