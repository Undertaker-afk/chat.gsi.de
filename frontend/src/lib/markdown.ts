/**
 * Prepare assistant markdown for <SvelteMarkdown> (@humanspeak/svelte-markdown).
 *
 * Rendering used to happen here: escape HTML, run `marked`, splice citation
 * anchors into the HTML string, and hand the result to `{@html}`. The component
 * renders the markdown itself now, so this module only rewrites `[n]` citation
 * markers into links that Message.svelte's `link` snippet turns into chips.
 *
 * Safety: the corpus is crawled from a wiki, so answers can echo arbitrary text
 * back at us. The old escape-before-parse step is what kept that inert; the
 * equivalent now is `renderers={{ html: buildUnsupportedHTML() }}` in
 * Message.svelte, which renders every HTML tag as escaped text instead of
 * executing it. Removing that prop would reintroduce the injection surface.
 */

const CITATION = /\[(\d{1,3})\]/g;

/**
 * Fenced blocks and inline code spans, captured so `split` returns them as
 * alternating odd-index parts. Longest-first so ``` wins over `.
 */
const CODE_REGIONS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+)/g;


/**
 * Citation links use a fragment href on purpose. The library sanitises URLs
 * against a protocol allowlist before any renderer sees them, and a made-up
 * scheme like `citation:1` would be stripped; `#...` is allowed through.
 */
const CITATION_HREF = /^#gsi-cite-(\d{1,3})$/;

export interface CitationLink {
	marker: number;
	url: string;
	title: string;
	heading: string;
}

/**
 * Rewrite `[n]` into `[n](#gsi-cite-n)` for markers that have a real source.
 *
 * Unknown markers are left as literal text, exactly as before -- the model
 * occasionally emits a number for a source it was not given, and inventing a
 * link target for it would be worse than showing the bare brackets.
 */
export function withCitationLinks(markdown: string, citations: CitationLink[]): string {
	const known = new Set(citations.map((c) => c.marker));

	return markdown
		.split(CODE_REGIONS)
		.map((part, i) => {
			// Odd parts are code. Leave them byte-for-byte: a command is quoted
			// verbatim from the docs, and a `[1]` inside one is array syntax, not a
			// citation. The renderer escapes code content itself.
			if (i % 2 === 1) return part;

			return (
				part
					// Backslash-escape, not `&lt;`. The renderer escapes `&` in text
					// too, so an entity here would come back out as the literal
					// characters `&lt;`. Markdown's own escape yields a real `<`.
					//
					// This is what stops any HTML token forming. buildUnsupportedHTML()
					// in Message.svelte is the second layer, and on its own would not
					// be enough: it covers only the 83 tags the library ships
					// renderers for, and an unrecognised tag is dropped silently --
					// `ssh <username>@lxlogin.gsi.de` would lose `<username>` outright.
					//
					// Cost: `<https://example.com>` autolink syntax stops working. GFM
					// autolinks bare URLs anyway, so nothing becomes unreachable.
					.replace(/</g, '\\<')
					.replace(CITATION, (whole, digits) => {
						const n = Number(digits);
						return known.has(n) ? `[${n}](#gsi-cite-${n})` : whole;
					})
			);
		})
		.join('');
}

/**
 * Same preparation for a standalone Markdown file: escaping and nothing else.
 *
 * A saved .md file has no citations to resolve, but it still needs the HTML
 * escaping -- it came out of the same model, and the viewer feeds it to the
 * same renderer.
 */
export const prepareMarkdown = (markdown: string) => withCitationLinks(markdown, []);

/** The marker a citation href refers to, or null if this is an ordinary link. */
export function citationMarker(href: string | undefined): number | null {
	const match = href?.match(CITATION_HREF);
	return match ? Number(match[1]) : null;
}

/** Citations actually referenced in the answer, in first-appearance order. */
export function usedCitations<T extends { marker: number }>(markdown: string, citations: T[]): T[] {
	const seen = new Set<number>();
	for (const m of markdown.matchAll(CITATION)) seen.add(Number(m[1]));
	return citations.filter((c) => seen.has(c.marker));
}
