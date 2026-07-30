/**
 * Per-user storage accounting.
 *
 * One quota (UPLOAD_QUOTA_BYTES, 1 GiB by default) covers everything a user
 * keeps on the server, split into two buckets the settings UI shows separately:
 *
 *   uploads  bytes of attachments in object storage
 *   chats    bytes of conversation text -- message content, agent traces and
 *            titles
 *
 * Chat text is measured with octet_length rather than pg_column_size: it is the
 * size of what the user actually wrote, not of TOAST-compressed storage, which
 * makes the number stable and explainable ("this conversation costs 40 KB")
 * instead of moving when Postgres changes its mind about compression.
 */
import { sql } from './db';
import { config } from './config';

export interface Usage {
	/** attachment bytes */
	uploads: number;
	/** conversation text bytes */
	chats: number;
	/** bytes of files the assistant generated and the user kept */
	generated: number;
	/** uploads + chats + generated */
	used: number;
	/** quota - used, never negative */
	free: number;
	quota: number;
	files: number;
	generatedFiles: number;
}

export async function usage(userSub: string): Promise<Usage> {
	const [row] = await sql<
		{ uploads: string; files: string; chats: string; generated: string; genfiles: string }[]
	>`
		SELECT
			(SELECT coalesce(sum(bytes), 0) FROM attachments WHERE user_sub = ${userSub})::text
				AS uploads,
			(SELECT count(*) FROM attachments WHERE user_sub = ${userSub})::text
				AS files,
			(SELECT coalesce(sum(bytes), 0) FROM generated_files WHERE user_sub = ${userSub})::text
				AS generated,
			(SELECT count(*) FROM generated_files WHERE user_sub = ${userSub})::text
				AS genfiles,
			(
				(SELECT coalesce(sum(
					 octet_length(m.content) + coalesce(octet_length(m.trace::text), 0)
				 ), 0)
				   FROM messages m
				   JOIN conversations c ON c.id = m.conversation_id
				  WHERE c.user_sub = ${userSub})
			  + (SELECT coalesce(sum(octet_length(coalesce(title, ''))), 0)
				   FROM conversations WHERE user_sub = ${userSub})
			)::text AS chats`;

	const uploads = Number(row?.uploads ?? 0);
	const chats = Number(row?.chats ?? 0);
	const generated = Number(row?.generated ?? 0);
	const quota = config.uploads.quotaBytes;
	const used = uploads + chats + generated;
	return {
		uploads,
		chats,
		generated,
		used,
		free: Math.max(0, quota - used),
		quota,
		files: Number(row?.files ?? 0),
		generatedFiles: Number(row?.genfiles ?? 0)
	};
}

export class QuotaExceeded extends Error {
	constructor(
		readonly usage: Usage,
		readonly needed: number
	) {
		super('storage quota exceeded');
	}
}

/** Tiered so a few hundred KB does not render as "0 MB". */
export function formatBytes(n: number): string {
	if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
	if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
	if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
	return `${n} B`;
}

/** Human-readable, German, for the 413 the client shows verbatim. */
export function quotaMessage(u: Usage): string {
	return (
		`Speicher voll: ${formatBytes(u.used)} von ${formatBytes(u.quota)} belegt ` +
		`(${formatBytes(u.uploads)} Uploads, ${formatBytes(u.chats)} Chats, ` +
		`${formatBytes(u.generated)} generierte Dateien). ` +
		`Löschen Sie Dateien oder Chats in den Einstellungen.`
	);
}
