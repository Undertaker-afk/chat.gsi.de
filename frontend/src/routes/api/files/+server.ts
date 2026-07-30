import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { listGenerated, saveGenerated, MAX_GENERATED_BYTES } from '$lib/server/generated';
import { QuotaExceeded, quotaMessage, usage } from '$lib/server/storage';

/** The user's generated files, plus the storage figures the UI shows alongside. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const [items, use] = await Promise.all([listGenerated(locals.user.sub), usage(locals.user.sub)]);
	return json({
		items,
		uploads: use.uploads,
		chats: use.chats,
		generated: use.generated,
		quota: use.quota
	});
};

/** Keep a fenced block from an answer. Same name overwrites -- see migration 012. */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'unauthenticated');

	const body = (await request.json()) as {
		filename?: unknown;
		content?: unknown;
		language?: unknown;
		messageId?: unknown;
	};

	if (typeof body.filename !== 'string' || !body.filename.trim()) {
		error(400, 'filename is required');
	}
	if (typeof body.content !== 'string') error(400, 'content is required');
	if (body.content.length > MAX_GENERATED_BYTES) error(413, 'Datei zu groß');

	try {
		const file = await saveGenerated(locals.user.sub, {
			filename: body.filename,
			content: body.content,
			language: typeof body.language === 'string' ? body.language : null,
			messageId: typeof body.messageId === 'string' ? body.messageId : null
		});
		return json({ file });
	} catch (e) {
		// The quota message is shown verbatim, so it is built server-side where the
		// numbers are, exactly as the upload path does.
		if (e instanceof QuotaExceeded) error(413, quotaMessage(e.usage));
		error(400, e instanceof Error ? e.message : 'Speichern fehlgeschlagen');
	}
};
