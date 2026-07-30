/**
 * The split-view panel next to the chat.
 *
 * Module-level state rather than props threaded down: a code block deep inside
 * a Message, and a PDF link inside a rendered answer, both need to open the
 * same panel, and neither has a path back up to the page component.
 */

/** Formats the panel can render, by MIME type. */
const OFFICE_MIME: Record<string, string> = {
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odp: 'application/vnd.oasis.opendocument.presentation',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	odt: 'application/vnd.oasis.opendocument.text',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ods: 'application/vnd.oasis.opendocument.spreadsheet'
};

export interface ViewerTarget {
	/** `pdf` and `slides` stream from `url`; `text` renders `content`. */
	kind: 'pdf' | 'slides' | 'text';
	filename: string;
	mime: string;
	language?: string | null;
	content?: string;
	url?: string;
	/** The address the answer actually linked, for "open the original". */
	sourceUrl?: string;
}

class ViewerState {
	target = $state<ViewerTarget | null>(null);

	get isOpen() {
		return this.target !== null;
	}

	open(target: ViewerTarget) {
		this.target = target;
	}

	/** Opens a PDF through the proxy -- see /api/pdf for why it cannot be direct. */
	openPdf(url: string, filename?: string) {
		this.openDocument(url, filename);
	}

	/**
	 * Opens any supported external document in the panel.
	 *
	 * Kind is decided from the URL's extension rather than by asking the server
	 * first: the panel has to render something immediately, and a wrong guess only
	 * costs the fallback message rather than a broken load. The proxy still
	 * enforces the real content type.
	 */
	openDocument(url: string, filename?: string) {
		const name = filename || decodeURIComponent(url.split('/').pop() || 'Dokument');
		const extension = (url.split('?')[0].split('.').pop() || '').toLowerCase();
		const office = OFFICE_MIME[extension];

		this.target = {
			// Only presentations get the slide renderer; a docx or xlsx has no
			// viewer here and falls through to "open the original".
			kind: extension === 'pptx' || extension === 'odp' ? 'slides' : 'pdf',
			mime: office ?? 'application/pdf',
			filename: name,
			url: `/api/pdf?url=${encodeURIComponent(url)}`,
			sourceUrl: url
		};
	}

	close() {
		this.target = null;
	}
}

export const viewer = new ViewerState();

/** Links the panel should intercept rather than opening in a new tab. */
export function isPdfLink(href: string | undefined): boolean {
	return isViewableDocument(href);
}

/**
 * Anything the panel can show. Kept in step with the server's EXTRACTABLE map --
 * a link the viewer intercepts but the proxy refuses is a dead end for the user.
 */
export function isViewableDocument(href: string | undefined): boolean {
	if (!href) return false;
	try {
		const parsed = new URL(href, 'http://chat.lab');
		if (!['http:', 'https:'].includes(parsed.protocol)) return false;
		return /\.(pdf|pptx|docx|xlsx|odp|odt|ods)$/i.test(parsed.pathname);
	} catch {
		return false;
	}
}
