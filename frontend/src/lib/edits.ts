/**
 * Search/replace blocks the assistant writes into an answer.
 *
 * Format (see EDIT_ADDENDUM in orchestrator/prompts):
 *
 *   ```edit submit_job.sh
 *   <<<<<<< SEARCH
 *   old text
 *   =======
 *   new text
 *   >>>>>>> REPLACE
 *   ```
 *
 * Parsed on the client rather than the server because it lives inside the
 * streamed answer text, which the server never re-reads. A block that does not
 * parse is shown as ordinary code -- a malformed edit must degrade to something
 * visible, not vanish.
 */

export interface FileEdit {
	filename: string;
	search: string;
	replace: string;
}

const BLOCK =
	/^<{5,9} SEARCH\s*\n([\s\S]*?)\n?={5,9}\s*\n([\s\S]*?)\n?>{5,9} REPLACE\s*$/;

/** True when this fence is an edit directive rather than a code sample. */
export function isEditFence(language: string): boolean {
	return language.toLowerCase() === 'edit';
}

export function parseEdit(filename: string, body: string): FileEdit | null {
	const name = filename.trim();
	if (!name) return null;

	const match = BLOCK.exec(body.trim());
	if (!match) return null;

	return { filename: name, search: match[1], replace: match[2] };
}

/**
 * Line-level diff for the preview.
 *
 * Deliberately not a real LCS diff: an edit block is already scoped to the few
 * lines the model chose, so showing the search half as removed and the replace
 * half as added is both accurate and easier to read than an alignment.
 */
export function diffLines(edit: FileEdit): { sign: '-' | '+'; text: string }[] {
	return [
		...edit.search.split('\n').map((text) => ({ sign: '-' as const, text })),
		...edit.replace.split('\n').map((text) => ({ sign: '+' as const, text }))
	];
}
