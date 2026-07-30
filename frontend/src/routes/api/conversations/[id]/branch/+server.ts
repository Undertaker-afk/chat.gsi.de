import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db';
import { conversationPath, selectBranch } from '$lib/server/tree';
import { serialiseMessage } from '$lib/server/messages';

/** Switch to a sibling version and return the branch that is now active. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const { messageId } = (await request.json()) as { messageId?: string };
	if (!messageId) error(400, 'messageId is required');

	const leaf = await selectBranch(params.id, locals.user.sub, messageId);
	if (!leaf) error(404, 'not found');

	const conversation = await getConversation(params.id, locals.user.sub);
	const path = await conversationPath(params.id, conversation!.active_leaf_id);
	return json({
		// The same shaper as the conversation route. Returning a thinner shape
		// here is what silently stripped the trace when switching versions.
		messages: path.map((m) => serialiseMessage(m))
	});
};
