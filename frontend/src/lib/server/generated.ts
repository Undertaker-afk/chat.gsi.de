/**
 * Files the assistant generated and the user chose to keep.
 *
 * Bytes go to object storage next to attachments; Postgres holds the index.
 * See db/migrations/012 for why this is its own table rather than a flag on
 * `attachments`.
 *
 * Everything here is text -- code, markdown, config, data. Binary generation is
 * out of scope: the model emits fenced code blocks, and that is what gets saved.
 * PDFs reach the system as uploads (uploads.ts), not from here.
 */
import { sql } from './db';
import { putObject, getObject, deleteObject, ensureBucketOnce } from './s3';
import { QuotaExceeded, usage } from './storage';

export interface GeneratedFile {
	id: string;
	filename: string;
	mime: string;
	language: string | null;
	bytes: number;
	created_at: string;
	message_id: string | null;
}

/**
 * Extension -> [mime, Monaco language id].
 *
 * The mime decides how the viewer renders (markdown gets the rendered/source
 * toggle, everything else is Monaco), so `text/markdown` must be exact.
 */
const BY_EXTENSION: Record<string, [string, string]> = {
	md: ['text/markdown', 'markdown'],
	markdown: ['text/markdown', 'markdown'],
	sh: ['text/x-shellscript', 'shell'],
	bash: ['text/x-shellscript', 'shell'],
	zsh: ['text/x-shellscript', 'shell'],
	py: ['text/x-python', 'python'],
	js: ['text/javascript', 'javascript'],
	mjs: ['text/javascript', 'javascript'],
	ts: ['text/typescript', 'typescript'],
	json: ['application/json', 'json'],
	yaml: ['application/yaml', 'yaml'],
	yml: ['application/yaml', 'yaml'],
	toml: ['text/x-toml', 'ini'],
	ini: ['text/x-ini', 'ini'],
	cfg: ['text/x-ini', 'ini'],
	conf: ['text/x-ini', 'ini'],
	sql: ['application/sql', 'sql'],
	c: ['text/x-c', 'c'],
	h: ['text/x-c', 'c'],
	cpp: ['text/x-c++', 'cpp'],
	hpp: ['text/x-c++', 'cpp'],
	cc: ['text/x-c++', 'cpp'],
	rs: ['text/x-rust', 'rust'],
	go: ['text/x-go', 'go'],
	java: ['text/x-java', 'java'],
	xml: ['application/xml', 'xml'],
	html: ['text/html', 'html'],
	css: ['text/css', 'css'],
	dockerfile: ['text/x-dockerfile', 'dockerfile'],
	slurm: ['text/x-shellscript', 'shell'],
	txt: ['text/plain', 'plaintext'],
	log: ['text/plain', 'plaintext']
};

/** Fence info string -> default extension, for naming a block the user saves. */
const BY_LANGUAGE: Record<string, string> = {
	bash: 'sh',
	sh: 'sh',
	shell: 'sh',
	console: 'sh',
	slurm: 'sh',
	python: 'py',
	py: 'py',
	javascript: 'js',
	js: 'js',
	typescript: 'ts',
	ts: 'ts',
	json: 'json',
	yaml: 'yaml',
	yml: 'yaml',
	toml: 'toml',
	ini: 'ini',
	sql: 'sql',
	c: 'c',
	cpp: 'cpp',
	rust: 'rs',
	go: 'go',
	java: 'java',
	xml: 'xml',
	html: 'html',
	css: 'css',
	dockerfile: 'dockerfile',
	markdown: 'md',
	md: 'md',
	text: 'txt'
};

export const MAX_GENERATED_BYTES = 2 * 1024 * 1024;

/** Suggested filename for a fenced block, e.g. ('bash', 0) -> 'snippet-1.sh'. */
export function suggestFilename(language: string | null, index = 0): string {
	const ext = BY_LANGUAGE[(language ?? '').toLowerCase()] ?? 'txt';
	return `snippet-${index + 1}.${ext}`;
}

export function classify(filename: string, language: string | null): {
	mime: string;
	language: string | null;
} {
	const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
	const byExt = BY_EXTENSION[ext];
	if (byExt) return { mime: byExt[0], language: byExt[1] };

	// No usable extension: fall back to the fence's language, then plain text.
	const fromFence = BY_EXTENSION[BY_LANGUAGE[(language ?? '').toLowerCase()] ?? ''];
	if (fromFence) return { mime: fromFence[0], language: fromFence[1] };
	return { mime: 'text/plain', language: 'plaintext' };
}

/**
 * Filenames are user-controlled and become part of an object key, so they are
 * reduced to a flat, safe basename. No directories: `../` traversal into another
 * user's prefix is the thing this exists to prevent.
 */
export function safeFilename(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? '';
	const cleaned = base
		.replace(/[^\w.\- ]+/g, '_')
		.replace(/^\.+/, '')
		.trim()
		.slice(0, 120);
	return cleaned || 'unbenannt.txt';
}

export async function listGenerated(userSub: string): Promise<GeneratedFile[]> {
	return sql<GeneratedFile[]>`
		SELECT id, filename, mime, language, bytes, created_at, message_id
		  FROM generated_files
		 WHERE user_sub = ${userSub}
		 ORDER BY created_at DESC`;
}

export async function saveGenerated(
	userSub: string,
	input: { filename: string; content: string; language?: string | null; messageId?: string | null }
): Promise<GeneratedFile> {
	const filename = safeFilename(input.filename);
	const body = Buffer.from(input.content, 'utf-8');

	if (body.byteLength === 0) throw new Error('leere Datei');
	if (body.byteLength > MAX_GENERATED_BYTES) {
		throw new Error(`zu groß: maximal ${MAX_GENERATED_BYTES / 1024 / 1024} MB`);
	}

	// Quota is shared with uploads and chat text. Checked before the write, and
	// the existing file's bytes are credited back when overwriting so re-saving
	// a file cannot creep past the limit.
	const [existing] = await sql<{ bytes: number; object_key: string }[]>`
		SELECT bytes, object_key FROM generated_files
		 WHERE user_sub = ${userSub} AND filename = ${filename}`;

	const current = await usage(userSub);
	const needed = body.byteLength - (existing?.bytes ?? 0);
	if (needed > 0 && current.free < needed) throw new QuotaExceeded(current, needed);

	const { mime, language } = classify(filename, input.language ?? null);

	await ensureBucketOnce();
	// Keyed by user so one prefix per account, and by a fresh uuid so an
	// overwrite never races a reader still holding the old presigned URL.
	const key = `generated/${userSub}/${crypto.randomUUID()}/${filename}`;
	await putObject(key, body, mime);

	const [row] = await sql<GeneratedFile[]>`
		INSERT INTO generated_files
			(user_sub, message_id, filename, mime, language, bytes, object_key)
		VALUES (${userSub}, ${input.messageId ?? null}, ${filename}, ${mime}, ${language},
		        ${body.byteLength}, ${key})
		ON CONFLICT (user_sub, filename) DO UPDATE SET
			message_id = EXCLUDED.message_id,
			mime       = EXCLUDED.mime,
			language   = EXCLUDED.language,
			bytes      = EXCLUDED.bytes,
			object_key = EXCLUDED.object_key,
			created_at = now()
		RETURNING id, filename, mime, language, bytes, created_at, message_id`;

	// Only after the row points at the new key, so a failure here leaves an
	// orphaned object rather than a row pointing at a deleted one.
	if (existing && existing.object_key !== key) {
		await deleteObject(existing.object_key).catch(() => {});
	}

	return row;
}

/** Content for the viewer. Ownership is enforced in the query, not the caller. */
export async function readGenerated(
	userSub: string,
	id: string
): Promise<{ file: GeneratedFile; content: string } | null> {
	const [row] = await sql<(GeneratedFile & { object_key: string })[]>`
		SELECT id, filename, mime, language, bytes, created_at, message_id, object_key
		  FROM generated_files
		 WHERE id = ${id} AND user_sub = ${userSub}`;
	if (!row) return null;

	const object = await getObject(row.object_key);
	if (!object) return null;

	const { object_key, ...file } = row;
	return { file, content: object.body.toString('utf-8') };
}

/**
 * Files produced in one conversation.
 *
 * The join through `messages` is what scopes the assistant's editing to the
 * conversation it is in: a file saved from another chat is not listed to the
 * model and cannot be named in an edit block.
 *
 * `message_id IS NULL` files belong to no conversation and are therefore never
 * listed here. That covers files whose chat has since been deleted -- they
 * survive by design (migration 016) and stay downloadable from /files, but with
 * the conversation gone there is nothing left to scope an edit to.
 */
export async function listGeneratedInConversation(
	userSub: string,
	conversationId: string
): Promise<GeneratedFile[]> {
	return sql<GeneratedFile[]>`
		SELECT g.id, g.filename, g.mime, g.language, g.bytes, g.created_at, g.message_id
		  FROM generated_files g
		  JOIN messages m ON m.id = g.message_id
		 WHERE g.user_sub = ${userSub} AND m.conversation_id = ${conversationId}
		 ORDER BY g.created_at DESC`;
}

/** Metadata only -- enough to draw the chip on a question, without the bytes. */
export interface AttachedFile {
	id: string;
	filename: string;
	mime: string;
	language: string | null;
	bytes: number;
}

/**
 * Record which generated files a question carried.
 *
 * Ownership is enforced in the INSERT rather than by the caller: the SELECT only
 * yields rows whose user_sub matches, so an id belonging to somebody else links
 * nothing instead of raising. Same shape as the uploads path.
 */
export async function linkAttachedFiles(
	messageId: string,
	userSub: string,
	fileIds: string[]
): Promise<void> {
	if (fileIds.length === 0) return;
	await sql`
		INSERT INTO message_attached_files (message_id, generated_file_id)
		SELECT ${messageId}, g.id
		  FROM generated_files g
		 WHERE g.user_sub = ${userSub} AND g.id = ANY(${fileIds})
		ON CONFLICT DO NOTHING`;
}

/** Attachments for a set of messages, keyed by message id. */
export async function attachedFilesFor(
	messageIds: string[]
): Promise<Map<string, AttachedFile[]>> {
	const out = new Map<string, AttachedFile[]>();
	if (messageIds.length === 0) return out;

	const rows = await sql<(AttachedFile & { message_id: string })[]>`
		SELECT l.message_id, g.id, g.filename, g.mime, g.language, g.bytes
		  FROM message_attached_files l
		  JOIN generated_files g ON g.id = l.generated_file_id
		 WHERE l.message_id = ANY(${messageIds})
		 ORDER BY g.filename`;

	for (const { message_id, ...file } of rows) {
		out.set(message_id, [...(out.get(message_id) ?? []), file]);
	}
	return out;
}

export class EditNotApplicable extends Error {}

/**
 * Apply one search/replace to a file the assistant produced in this conversation.
 *
 * The search text must occur exactly once. Rejecting an ambiguous match is the
 * point: the model proposes the edit from what it remembers writing, and if that
 * text appears twice there is no way to know which one it meant. A wrong guess
 * silently corrupts a file the user is about to run on a cluster.
 */
export async function applyEdit(
	userSub: string,
	conversationId: string,
	input: { filename: string; search: string; replace: string }
): Promise<{ file: GeneratedFile; content: string }> {
	const filename = safeFilename(input.filename);

	const [row] = await sql<
		{ id: string; object_key: string; language: string | null; message_id: string }[]
	>`
		SELECT g.id, g.object_key, g.language, g.message_id
		  FROM generated_files g
		  JOIN messages m ON m.id = g.message_id
		 WHERE g.user_sub = ${userSub}
		   AND g.filename = ${filename}
		   AND m.conversation_id = ${conversationId}`;
	if (!row) {
		throw new EditNotApplicable(`„${filename}“ gehört nicht zu dieser Unterhaltung.`);
	}

	const object = await getObject(row.object_key);
	if (!object) throw new EditNotApplicable('Der Dateiinhalt ist nicht mehr vorhanden.');
	const before = object.body.toString('utf-8');

	if (input.search === '') throw new EditNotApplicable('Der Suchtext ist leer.');
	const occurrences = before.split(input.search).length - 1;
	if (occurrences === 0) {
		throw new EditNotApplicable('Der gesuchte Abschnitt steht so nicht in der Datei.');
	}
	if (occurrences > 1) {
		throw new EditNotApplicable(
			`Der gesuchte Abschnitt kommt ${occurrences}-mal vor — die Änderung wäre mehrdeutig.`
		);
	}

	// Spliced by index rather than String.replace: with a string pattern, `$&`
	// and `$'` in the replacement are substitution directives, and a shell script
	// or a regex in the new text would come out mangled.
	const at = before.indexOf(input.search);
	const after = before.slice(0, at) + input.replace + before.slice(at + input.search.length);

	const file = await saveGenerated(userSub, {
		filename,
		content: after,
		language: row.language,
		// Carried over deliberately: saveGenerated overwrites message_id on
		// conflict, and dropping it would detach the file from the conversation --
		// after one edit it could never be edited again.
		messageId: row.message_id
	});
	return { file, content: after };
}

export async function deleteGenerated(userSub: string, id: string): Promise<boolean> {
	const [row] = await sql<{ object_key: string }[]>`
		DELETE FROM generated_files
		 WHERE id = ${id} AND user_sub = ${userSub}
		RETURNING object_key`;
	if (!row) return false;
	await deleteObject(row.object_key).catch(() => {});
	return true;
}
