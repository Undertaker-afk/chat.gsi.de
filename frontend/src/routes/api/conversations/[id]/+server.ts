import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { serialiseMessage } from '$lib/server/messages';
import { deleteConversation, getConversation, renameConversation } from '$lib/server/db';
import { conversationPath } from '$lib/server/tree';
import { attachedFilesFor } from '$lib/server/generated';

/** The branch currently on screen, with version counters for the < n/m > control. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const conversation = await getConversation(params.id, locals.user.sub);
	if (!conversation) error(404, 'not found');

	const path = await conversationPath(conversation.id, conversation.active_leaf_id);
	// One query for the whole branch rather than one per message.
	const attached = await attachedFilesFor(path.map((m) => m.id));

	return json({
		id: conversation.id,
		title: conversation.title,
		mode: conversation.mode,
		messages: path.map((m) => serialiseMessage(m, attached.get(m.id) ?? []))
	});
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const { title } = (await request.json()) as { title?: string };
	if (!title?.trim()) error(400, 'title is required');
	await renameConversation(params.id, locals.user.sub, title.trim());
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	await deleteConversation(params.id, locals.user.sub);
	return json({ ok: true });
};
