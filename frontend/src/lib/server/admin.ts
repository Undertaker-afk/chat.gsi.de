/**
 * Admin operations that touch multiple subsystems.
 *
 * purgeUserData removes every trace of a user: chats, uploads, generated files,
 * group membership, grants, audit entries, and the app_users row itself.
 * S3 objects are deleted alongside their db rows; a partial failure leaves
 * orphaned objects (preferable to leaving db rows pointing at nothing).
 */
import { sql } from './db';
import { deleteObject } from './s3';
import { log } from './log';

export interface PurgeResult {
	conversations: number;
	attachments: number;
	generatedFiles: number;
	groupMemberships: number;
	s3ObjectsDeleted: number;
	s3Errors: number;
}

export async function purgeUserData(sub: string): Promise<PurgeResult> {
	const result: PurgeResult = {
		conversations: 0,
		attachments: 0,
		generatedFiles: 0,
		groupMemberships: 0,
		s3ObjectsDeleted: 0,
		s3Errors: 0
	};
	let dbError: string | null = null;

	// --- Attachments (uploads): delete DB rows first, then S3 objects ---
	try {
		const attachments = await sql<{ object_key: string }[]>`
			DELETE FROM attachments WHERE user_sub = ${sub}
			RETURNING object_key`;
		result.attachments = attachments.length;
		for (const a of attachments) {
			try { await deleteObject(a.object_key); result.s3ObjectsDeleted++; }
			catch (e) { log.error('purge: s3 delete failed', { kind: 'admin', key: a.object_key, error: String(e) }); result.s3Errors++; }
		}
	} catch (e) { dbError = String(e); }

	// --- Generated files ---
	if (!dbError) try {
		const generated = await sql<{ object_key: string }[]>`
			DELETE FROM generated_files WHERE user_sub = ${sub}
			RETURNING object_key`;
		result.generatedFiles = generated.length;
		for (const g of generated) {
			try { await deleteObject(g.object_key); result.s3ObjectsDeleted++; }
			catch (e) { log.error('purge: s3 delete failed', { kind: 'admin', key: g.object_key, error: String(e) }); result.s3Errors++; }
		}
	} catch (e) { dbError = String(e); }

	// --- Conversations (cascades to messages, citations) ---
	if (!dbError) try {
		const convs = await sql<{ id: string }[]>`
			DELETE FROM conversations WHERE user_sub = ${sub}
			RETURNING id`;
		result.conversations = convs.length;
	} catch (e) { dbError = String(e); }

	// --- Hidden conversations ---
	if (!dbError) try { await sql`DELETE FROM hidden_conversations WHERE user_sub = ${sub}`; } catch (e) { dbError = String(e); }

	// --- Group membership ---
	if (!dbError) try {
		const m = await sql`DELETE FROM group_members WHERE user_sub = ${sub}`;
		result.groupMemberships = m.count;
	} catch (e) { dbError = String(e); }

	// --- Per-member grants ---
	if (!dbError) try { await sql`DELETE FROM member_grants WHERE user_sub = ${sub}`; } catch (e) { dbError = String(e); }

	// --- Audit log ---
	if (!dbError) try { await sql`DELETE FROM audit_log WHERE actor_sub = ${sub}`; } catch (e) { dbError = String(e); }

	// --- The user row ---
	if (!dbError) try { await sql`DELETE FROM app_users WHERE sub = ${sub}`; } catch (e) { dbError = String(e); }

	if (dbError) {
		log.error('purge: db error, some data may remain', { kind: 'admin', sub, error: dbError });
		throw new Error(dbError);
	}

	log.info('user purged', { kind: 'admin', sub, ...result });
	return result;
}
