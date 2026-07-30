/**
 * Egress boundary for the PDF proxy.
 *
 * A URL may be fetched when it is either
 *   1. at or under gsi.de -- the crawler's own boundary, or
 *   2. linked from a document in the corpus (db/migrations/015).
 *
 * (2) exists because the answers cite papers GSI hosts elsewhere:
 * accelconf.web.cern.ch, proceedings.jacow.org, epics-controls.org. Those are
 * legitimate targets -- our own crawler read the page that links them -- but the
 * old host-only rule rejected every one with a 403.
 *
 * It is still an allowlist, not an open relay: membership is decided by data the
 * crawler produced from gsi.de pages, and a caller cannot add to it. Redirects
 * are handled separately (see `assertPublicHost`), because the *target* of a
 * redirect is chosen by the remote host rather than by us.
 */
import { sql } from './db';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const ALLOWED_HOSTS = ['gsi.de'];

export class ScopeError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

/** http/https only, fragment dropped. Returns null for anything else. */
export function parseTarget(raw: string): URL | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	// The fragment is never sent to the server and would only defeat the cache
	// key and the corpus lookup.
	parsed.hash = '';
	return parsed;
}

/**
 * Hostname, lowercased, trailing dot removed.
 *
 * Userinfo is split off from the RIGHT: `https://gsi.de@evil.com/x` is an
 * evil.com URL, and taking the left-hand side would read it as gsi.de. (URL
 * already parses this correctly; the split stays as belt and braces for hosts
 * reached through the string paths below.)
 */
export function hostOf(url: URL): string {
	return url.hostname.split('@').pop()!.toLowerCase().replace(/\.$/, '');
}

export function underGsiDe(url: URL): boolean {
	const host = hostOf(url);
	return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Candidate spellings of one URL, for matching against what the crawler stored.
 *
 * `web-docs.gsi.de/%7Ego4/...` and `web-docs.gsi.de/~go4/...` are the same
 * document, and which of the two ends up in the corpus depends on how the page
 * that linked it was written.
 */
function variants(url: URL): string[] {
	const raw = url.toString();
	const out = new Set([raw]);
	try {
		const decoded = decodeURI(raw);
		out.add(decoded);
		out.add(encodeURI(decoded));
	} catch {
		/* malformed escape: the raw form is all we have */
	}
	// Trailing-slash difference is not meaningful for a document URL.
	if (raw.endsWith('/')) out.add(raw.slice(0, -1));
	return [...out];
}

/** True when some crawled document links this URL, or is this URL. */
export async function referencedInCorpus(url: URL): Promise<boolean> {
	const candidates = variants(url).map((v) => v.toLowerCase());
	const [row] = await sql<{ found: boolean }[]>`
		SELECT EXISTS (
			SELECT 1 FROM document_links WHERE lower(url) = ANY(${candidates})
			UNION ALL
			SELECT 1 FROM documents
			 WHERE deleted_at IS NULL AND lower(url) = ANY(${candidates})
		) AS found`;
	return row?.found ?? false;
}

/**
 * Literal IP ranges that must never be reachable through the proxy: loopback,
 * RFC1918, link-local (which is how cloud metadata endpoints are addressed),
 * CGNAT and the IPv6 equivalents.
 */
function isPrivateAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) {
		const [a, b] = ip.split('.').map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a >= 224
		);
	}
	if (family === 6) {
		const v6 = ip.toLowerCase();
		// IPv4-mapped (::ffff:10.0.0.1) has to be judged as the IPv4 address.
		const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return isPrivateAddress(mapped[1]);
		return (
			v6 === '::' ||
			v6 === '::1' ||
			v6.startsWith('fc') ||
			v6.startsWith('fd') ||
			v6.startsWith('fe8') ||
			v6.startsWith('fe9') ||
			v6.startsWith('fea') ||
			v6.startsWith('feb')
		);
	}
	return false;
}

/**
 * Resolve a host and refuse it if any address is internal.
 *
 * Applied to every hop, including redirect targets. A redirect is the one place
 * where the destination is picked by a remote server rather than by our
 * allowlist, so this is what stops an allowlisted host from bouncing the proxy
 * at 169.254.169.254 or at something on the lab subnet.
 */
export async function assertPublicHost(url: URL): Promise<void> {
	const host = hostOf(url);
	if (!host) throw new ScopeError(400, 'URL ohne Host');

	if (isIP(host)) {
		if (isPrivateAddress(host)) throw new ScopeError(403, 'interne Adresse');
		return;
	}

	let addresses: { address: string }[];
	try {
		addresses = await lookup(host, { all: true });
	} catch {
		throw new ScopeError(502, `Host ${host} ist nicht auflösbar`);
	}
	if (addresses.length === 0) throw new ScopeError(502, `Host ${host} ist nicht auflösbar`);
	if (addresses.some((a) => isPrivateAddress(a.address))) {
		throw new ScopeError(403, 'interne Adresse');
	}
}

/**
 * Full check for the URL the *user* asked for. Throws ScopeError on refusal.
 */
export async function assertFetchable(raw: string): Promise<URL> {
	const url = parseTarget(raw);
	if (!url) throw new ScopeError(400, 'Keine gültige http(s)-URL');

	if (!underGsiDe(url) && !(await referencedInCorpus(url))) {
		throw new ScopeError(403, 'Diese Adresse ist in der Dokumentation nicht verlinkt');
	}
	await assertPublicHost(url);
	return url;
}
