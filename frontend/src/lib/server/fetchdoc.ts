/**
 * Fetching an external document, safely.
 *
 * This was the body of /api/pdf until the documents agent needed the same thing.
 * It is shared rather than copied on purpose: it is the egress boundary, every
 * hop is re-checked here, and a fix applied to one copy and not the other is
 * exactly how that kind of code rots.
 *
 * Everything throws `ScopeError`, never SvelteKit's `error()`. The route maps
 * those to HTTP; the agent catches and moves on to the next candidate. A module
 * that threw framework errors could not be used off a request path at all.
 */
import { assertPublicHost, parseTarget, ScopeError } from './pdfscope';

const MAX_REDIRECTS = 5;

/**
 * Ceiling for one fetched document. Generous because GSI annual reports and
 * thesis PDFs genuinely run to tens of megabytes, and the viewer is expected to
 * open them.
 */
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

export interface FetchedDocument {
	bytes: Uint8Array<ArrayBuffer>;
	mime: string;
}

/**
 * Follow `start` to a final response, re-checking every hop.
 *
 * `redirect: 'follow'` would hide the intermediate hops, and the hops are the
 * interesting part: an allowlisted host is free to redirect anywhere, so each
 * destination is re-resolved and refused if it points inside the network. The
 * destination does NOT have to be in the corpus -- accelconf.web.cern.ch sends
 * every paper on to proceedings.jacow.org, and that is the normal case, not an
 * attack.
 */
export async function follow(
	start: URL,
	fetch: typeof globalThis.fetch,
	accept = 'application/pdf,*/*'
): Promise<Response> {
	let current = start;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await request(current, fetch, accept);

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) throw new ScopeError(502, `Weiterleitung ohne Ziel (${response.status})`);
			const next = parseTarget(new URL(location, current).toString());
			if (!next) throw new ScopeError(502, 'Weiterleitung auf ein nicht unterstütztes Protokoll');
			await assertPublicHost(next);
			current = next;
			continue;
		}

		if (response.status === 404 || response.status === 410) {
			throw new ScopeError(404, 'Das Dokument liegt unter dieser Adresse nicht mehr vor.');
		}
		if (!response.ok) throw new ScopeError(502, `Der Server hat mit ${response.status} geantwortet.`);
		return response;
	}

	throw new ScopeError(502, 'Zu viele Weiterleitungen');
}

/**
 * One hop, with a single retry.
 *
 * wiki.gsi.de drops roughly one connection in four with "other side closed"
 * (measured 2026-07-29: 3 of 4 requests succeeded, the fourth failed at the
 * socket). That is a transient server-side reset, and failing the whole request
 * for it means a PDF that loads on the second click but not the first.
 */
async function request(
	target: URL,
	fetch: typeof globalThis.fetch,
	accept: string
): Promise<Response> {
	let lastError: unknown;

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await fetch(target, {
				redirect: 'manual',
				headers: { accept },
				signal: AbortSignal.timeout(30_000)
			});
		} catch (e) {
			lastError = e;
		}
	}

	const cause = lastError instanceof Error ? (lastError.cause ?? lastError) : lastError;
	const detail = cause instanceof Error ? cause.message : String(cause);

	// A wrong certificate is the single most common failure here -- several GSI
	// vhosts (www-alt, www-ap) serve a certificate that does not name them -- and
	// "fetch failed" tells the user nothing about it.
	if (/certificate|altnames|self-signed/i.test(detail)) {
		throw new ScopeError(502, `TLS-Zertifikat von ${target.hostname} ist ungültig.`);
	}
	if (/ENOTFOUND|EAI_AGAIN/i.test(detail)) {
		throw new ScopeError(502, `Host ${target.hostname} existiert nicht mehr.`);
	}
	if (/timeout|ETIMEDOUT/i.test(detail)) {
		throw new ScopeError(504, `${target.hostname} antwortet nicht.`);
	}
	throw new ScopeError(502, `Abruf fehlgeschlagen: ${detail}`);
}

/**
 * Read a response body with a hard ceiling, checking the declared length first.
 *
 * Both checks are needed: `content-length` is a claim and may be absent or a
 * lie, and without the second check a host that omits it could stream until the
 * process runs out of memory.
 */
export async function readCapped(
	upstream: Response,
	maxBytes: number,
	what = 'Dokument'
): Promise<Uint8Array<ArrayBuffer>> {
	const declared = Number(upstream.headers.get('content-length') ?? 0);
	if (declared > maxBytes) throw new ScopeError(413, `${what} zu groß`);

	const bytes = new Uint8Array(await upstream.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new ScopeError(413, `${what} zu groß`);
	return bytes;
}

/** The MIME type, lowercased, without parameters. */
export function mimeOf(response: Response): string {
	return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}
