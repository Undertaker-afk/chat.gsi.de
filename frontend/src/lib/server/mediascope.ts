/**
 * Egress boundary for the media library client.
 *
 * Narrower than the PDF proxy's rule on purpose. That one has to reach the
 * conference hosts GSI publishes to; this one only ever talks to two hosts, and
 * every URL it follows comes out of parsed HTML -- which is untrusted input, no
 * matter that we trust the site that served it.
 */

const ALLOWED = new Set(['media.gsi.de', 'media-images.gsi.de']);

export function in_scope_media(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;

	// Userinfo split from the RIGHT: `https://media.gsi.de@evil.com/x` is an
	// evil.com URL, and taking the left-hand side would read it as ours.
	const host = url.hostname.split('@').pop()!.toLowerCase().replace(/\.$/, '');
	return ALLOWED.has(host);
}
