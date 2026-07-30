/**
 * User uploads (see db/migrations/007_attachments_object_store.sql).
 *
 * The browser uploads a file and gets back an id; messages then reference
 * `/api/uploads/<id>`. Postgres holds the index -- owner, size, mime, which
 * message it belongs to -- and SeaweedFS holds the bytes.
 *
 * The bytes leave storage in exactly two directions: to their owner, through a
 * short-lived presigned link that /api/uploads/<id> mints after checking the
 * session, and -- base64-encoded -- to the vision model at send time.
 */
import { randomUUID } from 'node:crypto';
import { sql } from './db';
import { config } from './config';
import {
	EXTRACTABLE,
	extractDocumentText,
	normalise,
	UnreadableDocument
} from './sources/extract';
import { log } from './log';
import { deleteObject, ensureBucketOnce, getObject, presignGet, putObject } from './s3';
import { QuotaExceeded, usage } from './storage';
import { metrics } from './metrics';

/**
 * Images, PDFs and Office documents.
 *
 * The two kinds reach the model by completely different routes, and conflating
 * them is how a PDF used to arrive as `data:application/pdf;base64,...` inside an
 * `image_url` part that the vision model could not read:
 *
 *   * images  -> base64 data URL, straight to the vision model
 *   * documents -> text, extracted server-side first (see `asDocumentTexts`)
 *
 * That is what makes an uploaded slide deck answerable rather than merely
 * re-openable. Text also costs a fraction of what a page render would.
 */
export const ALLOWED_MIME = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	...Object.keys(EXTRACTABLE)
]);

/** Which attachments are safe to hand to the vision model. */
export const isImage = (mime: string) => mime.startsWith('image/');

/** Which attachments become text before the model sees them. */
export const isExtractable = (mime: string) => mime in EXTRACTABLE;

export interface Attachment {
	id: string;
	filename: string | null;
	mime: string;
	bytes: number;
	created_at: Date;
	message_id: string | null;
}

/** `bytes` is bigint since 007, which the driver hands back as a string. */
const toAttachment = (row: Attachment): Attachment => ({
	...row,
	bytes: Number(row.bytes)
});

export async function list(userSub: string, limit = 500): Promise<Attachment[]> {
	const rows = await sql<Attachment[]>`
		SELECT id, filename, mime, bytes, created_at, message_id
		  FROM attachments WHERE user_sub = ${userSub}
		 ORDER BY created_at DESC LIMIT ${limit}`;
	return rows.map(toAttachment);
}

/**
 * Object key layout: users/<sub>/<uuid>.
 *
 * Prefixed by owner so a listing of one user's data is a single prefix scan,
 * and suffixed with a fresh uuid so the key never depends on the (attacker-
 * supplied) filename. SeaweedFS spreads objects across volume servers by
 * itself, so the prefix carries no sharding meaning.
 */
function objectKey(userSub: string): string {
	const safe = userSub.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
	return `users/${safe}/${randomUUID()}`;
}

export async function store(
	userSub: string,
	file: { name: string | null; mime: string; bytes: Uint8Array }
): Promise<Attachment> {
	// Rejections are counted by reason rather than lumped together: "users keep
	// hitting the quota" and "users keep attaching .docx" are both worth knowing
	// and lead to completely different fixes.
	if (!ALLOWED_MIME.has(file.mime)) {
		metrics.uploadsRejected.inc({ reason: 'unsupported_type' });
		throw new Error(`unsupported type: ${file.mime}`);
	}
	if (file.bytes.byteLength > config.uploads.maxFileBytes) {
		metrics.uploadsRejected.inc({ reason: 'too_large' });
		throw new Error(
			`file too large: ${file.bytes.byteLength} > ${config.uploads.maxFileBytes} bytes`
		);
	}

	// Checked before writing rather than by a constraint, so the user gets a
	// message with the numbers in it. Chats count against the same quota.
	const current = await usage(userSub);
	if (current.used + file.bytes.byteLength > current.quota) {
		metrics.uploadsRejected.inc({ reason: 'quota' });
		throw new QuotaExceeded(current, file.bytes.byteLength);
	}

	// Bytes first: an object with no row is invisible garbage that a later sweep
	// can collect, whereas a row with no object is a broken image in a message.
	const key = objectKey(userSub);
	await ensureBucketOnce();
	await putObject(key, Buffer.from(file.bytes), file.mime);

	try {
		const [row] = await sql<Attachment[]>`
			INSERT INTO attachments (user_sub, filename, mime, bytes, object_key)
			VALUES (${userSub}, ${file.name}, ${file.mime}, ${file.bytes.byteLength}, ${key})
			RETURNING id, filename, mime, bytes, created_at, message_id`;
		// Counted only once the row exists. An object written but never indexed is
		// the orphan case, and it belongs in the S3-vs-database gap on the storage
		// dashboard, not in the accepted-uploads count.
		metrics.uploadsStored.inc({ mime: file.mime });
		metrics.uploadSize.observe({ mime: file.mime }, file.bytes.byteLength);
		return toAttachment(row);
	} catch (err) {
		await deleteObject(key).catch(() => {});
		throw err;
	}
}

/**
 * An ephemeral direct link to the object, or null if the id is not this user's.
 *
 * Ownership is checked here, in the session's context; the returned URL then
 * carries its own signature and expires on its own. Nothing about the id alone
 * grants access.
 */
export async function directLink(id: string, userSub: string): Promise<string | null> {
	const [row] = await sql<{ object_key: string; mime: string; filename: string | null }[]>`
		SELECT object_key, mime, filename FROM attachments
		 WHERE id = ${id} AND user_sub = ${userSub}`;
	if (!row) return null;
	return presignGet(row.object_key, config.s3.linkTtlSeconds, {
		contentType: row.mime,
		filename: row.filename ?? undefined
	});
}

export async function remove(id: string, userSub: string): Promise<boolean> {
	const [row] = await sql<{ object_key: string }[]>`
		DELETE FROM attachments WHERE id = ${id} AND user_sub = ${userSub}
		RETURNING object_key`;
	if (!row) return false;
	// Row gone first, so a failed delete leaves an orphan object rather than an
	// undeletable row the user still pays for.
	await deleteObject(row.object_key).catch(() => {});
	return true;
}

/** Attach uploads to the message that sent them, so deleting it frees the space. */
export async function linkToMessage(ids: string[], userSub: string, messageId: string) {
	if (ids.length === 0) return;
	await sql`
		UPDATE attachments SET message_id = ${messageId}
		 WHERE id = ANY(${ids}) AND user_sub = ${userSub} AND message_id IS NULL`;
}

/**
 * Base64 data URLs for the vision model. The proxy cannot reach our server, so
 * the bytes have to travel inline.
 */
export async function asDataUrls(ids: string[], userSub: string): Promise<string[]> {
	if (ids.length === 0) return [];
	const rows = await sql<{ id: string; mime: string; object_key: string }[]>`
		SELECT id, mime, object_key FROM attachments
		 WHERE id = ANY(${ids}) AND user_sub = ${userSub}`;
	// Images only. An unfiltered list would hand the proxy
	// `data:application/pdf;base64,...` inside an image_url part, which the vision
	// model cannot read. Documents go through `asDocumentTexts` instead.
	const byId = new Map(rows.filter((r) => isImage(r.mime)).map((r) => [r.id, r]));

	// Preserve the order the user attached them in, and skip anything whose
	// object has gone missing rather than failing the whole turn.
	const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
	const fetched = await Promise.all(
		ordered.map(async (r) => {
			const object = await getObject(r.object_key);
			return object ? `data:${r.mime};base64,${object.body.toString('base64')}` : null;
		})
	);
	return fetched.filter((url): url is string => url !== null);
}

/**
 * Extracted text for every non-image attachment on a turn.
 *
 * Runs the same extractor the documents agent uses, so an uploaded PDF and a PDF
 * fetched from Indico are read by identical code -- one place to fix, one place
 * to get right.
 *
 * A file that cannot be extracted is skipped with a log line rather than failing
 * the turn: a scanned PDF with no text layer is an ordinary thing for someone to
 * attach, and the rest of their question still deserves an answer.
 */
export async function asDocumentTexts(
	ids: string[],
	userSub: string
): Promise<{ filename: string; content: string }[]> {
	if (ids.length === 0) return [];

	const rows = await sql<
		{ id: string; mime: string; object_key: string; filename: string | null }[]
	>`
		SELECT id, mime, object_key, filename FROM attachments
		 WHERE id = ANY(${ids}) AND user_sub = ${userSub}`;

	const byId = new Map(rows.filter((r) => isExtractable(r.mime)).map((r) => [r.id, r]));
	const ordered = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);

	const texts = await Promise.all(
		ordered.map(async (row) => {
			try {
				const object = await getObject(row.object_key);
				if (!object) return null;
				const bytes = new Uint8Array(object.body);
				const { text } = await extractDocumentText(bytes, row.mime);
				const content = normalise(text).slice(0, config.uploads.maxAttachmentChars);
				if (!content) return null;
				return { filename: row.filename ?? 'Dokument', content };
			} catch (e) {
				log.info('attachment could not be extracted', {
					kind: 'uploads',
					mime: row.mime,
					reason: e instanceof UnreadableDocument ? e.message : String(e)
				});
				return null;
			}
		})
	);

	return texts.filter((t): t is { filename: string; content: string } => t !== null);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAttachmentId = (value: string) => UUID.test(value);

export { QuotaExceeded, usage } from './storage';
