/**
 * Turning document bytes into text.
 *
 * Two extractors, chosen by MIME type:
 *
 *   * `unpdf` for PDFs -- a pure-JS pdf.js build, already used before office
 *     formats were supported, and better at PDFs than the general parser.
 *   * `officeparser` for everything Microsoft and OpenDocument.
 *
 * `officeparser` over `markit-ai`: both were considered, and markit-ai is an
 * LLM-assisted converter. We already pay for a model call to judge relevance, and
 * a second one per document to convert it would double the agent's cost for text
 * that officeparser produces deterministically and offline. An LLM in the
 * extraction path also means a document's contents can be paraphrased before
 * anyone sees them, which is the wrong place for that to happen in a system whose
 * whole claim is that answers are traceable to sources.
 */
import { extractText as extractPdfText } from 'unpdf';
import { parseOffice } from 'officeparser';

/**
 * What we can turn into text, by MIME type.
 *
 * Keyed on MIME rather than extension because the extension is a hint from a URL
 * and the MIME comes from the server that actually holds the file. Indico serves
 * correct types; a URL ending in `.pdf` does not always hold one.
 */
export const EXTRACTABLE: Record<string, 'pdf' | 'office'> = {
	'application/pdf': 'pdf',
	// OOXML: pptx, docx, xlsx
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'office',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'office',
	// OpenDocument
	'application/vnd.oasis.opendocument.presentation': 'office',
	'application/vnd.oasis.opendocument.text': 'office',
	'application/vnd.oasis.opendocument.spreadsheet': 'office'
};

/** Extensions worth *attempting*, used to decide whether a hit is worth a slot. */
export const EXTRACTABLE_EXTENSIONS = /\.(pdf|pptx|docx|xlsx|odp|odt|ods)$/i;

export interface ExtractedText {
	text: string;
	/** Pages for a PDF; 0 when the format has no page count we can cheaply get. */
	pages: number;
}

export class UnreadableDocument extends Error {}

/**
 * Extract text, or throw `UnreadableDocument`.
 *
 * A scanned PDF with no text layer, a password-protected deck and a corrupt file
 * all land here, and all three are ordinary rather than exceptional -- the agent
 * drops the candidate and carries on.
 */
export async function extractDocumentText(
	bytes: Uint8Array<ArrayBuffer>,
	mime: string
): Promise<ExtractedText> {
	const kind = EXTRACTABLE[mime];
	if (!kind) throw new UnreadableDocument(`kein unterstütztes Format (${mime || 'unbekannt'})`);

	try {
		if (kind === 'pdf') {
			const extracted = await extractPdfText(bytes, { mergePages: true });
			return {
				// `mergePages` gives a string; the union type covers the false case.
				text: Array.isArray(extracted.text) ? extracted.text.join('\n') : extracted.text,
				pages: extracted.totalPages
			};
		}

		// officeparser takes a Buffer and returns a document object, NOT a string --
		// `.toText()` is what yields the flat text. Verified against a 10 MB CBM
		// deck from Indico: 12069 characters, 0 warnings.
		//
		// Flat text is what we want. Slide layout carries no meaning once it is in
		// a model's context, and reconstructing it would only spend tokens.
		const parsed = await parseOffice(Buffer.from(bytes));
		return { text: parsed.toText(), pages: 0 };
	} catch (e) {
		throw new UnreadableDocument(e instanceof Error ? e.message : String(e));
	}
}

/** Collapse the whitespace both extractors leave behind. */
export function normalise(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
