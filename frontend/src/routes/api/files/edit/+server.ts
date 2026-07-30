import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { applyEdit, EditNotApplicable } from '$lib/server/generated';
import { getConversation } from '$lib/server/db';
import { QuotaExceeded, quotaMessage } from '$lib/server/storage';

/**
 * Apply a search/replace the assistant proposed (see EDIT_ADDENDUM in
 * orchestrator/prompts).
 *
 * The conversation is the scope: a file may only be edited from the chat it was
 * generated in. Both halves are checked server-side -- the conversation must
 * belong to the caller, and the file must belong to that conversation -- because
 * the client sends both ids and neither can be trusted.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'unauthenticated');

	const body = (await request.json()) as {
		conversationId?: unknown;
		filename?: unknown;
		search?: unknown;
		replace?: unknown;
	};

	if (typeof body.conversationId !== 'string') error(400, 'conversationId is required');
	if (typeof body.filename !== 'string' || !body.filename.trim()) error(400, 'filename is required');
	if (typeof body.search !== 'string') error(400, 'search is required');
	if (typeof body.replace !== 'string') error(400, 'replace is required');

	// Scoped by user_sub, so a forged id resolves to nothing rather than to
	// somebody else's conversation.
	const conversation = await getConversation(body.conversationId, locals.user.sub);
	if (!conversation) error(404, 'Unterhaltung nicht gefunden');

	try {
		const { file } = await applyEdit(locals.user.sub, conversation.id, {
			filename: body.filename,
			search: body.search,
			replace: body.replace
		});
		return json({ file });
	} catch (e) {
		if (e instanceof EditNotApplicable) error(409, e.message);
		if (e instanceof QuotaExceeded) error(413, quotaMessage(e.usage));
		error(400, e instanceof Error ? e.message : 'Änderung fehlgeschlagen');
	}
};
