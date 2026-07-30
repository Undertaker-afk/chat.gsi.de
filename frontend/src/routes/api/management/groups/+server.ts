import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { knowledgeBases, managedGroups } from '$lib/server/permissions';

/** The groups this manager actually manages. Never all groups. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const [mine, kbs] = await Promise.all([managedGroups(locals.user.sub), knowledgeBases()]);
	// Only the knowledge bases that appear in some ceiling of theirs are relevant;
	// the rest are none of their business and are not sent to the browser.
	const reachable = new Set(mine.flatMap((g) => g.kb_ids));
	return json({
		groups: mine,
		knowledgeBases: kbs.filter((kb) => reachable.has(kb.id))
	});
};
