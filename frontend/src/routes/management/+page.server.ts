import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { isAdmin, isPrivileged, knowledgeBases, managedGroups } from '$lib/server/permissions';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) error(401, 'unauthenticated');
	if (!isPrivileged(user) && !isAdmin(user)) error(403, 'not allowed');

	// Managing is not a role, it is a role PLUS a manager row on a group. Someone
	// holding llmbot-privileged with no group sees an honest empty state rather
	// than a broken page.
	const [groups, kbs] = await Promise.all([managedGroups(user.sub), knowledgeBases()]);
	const reachable = new Set(groups.flatMap((g) => g.kb_ids));
	return {
		groups,
		knowledgeBases: kbs.filter((kb) => reachable.has(kb.id)),
		user
	};
};
