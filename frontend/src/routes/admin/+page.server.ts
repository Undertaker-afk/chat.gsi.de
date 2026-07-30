import type { PageServerLoad } from './$types';
import { assertAdmin, groups, knowledgeBases } from '$lib/server/permissions';

/**
 * The role is already enforced in hooks.server.ts for /admin/**; asserting again
 * here is deliberate belt-and-braces -- this load is the only thing standing
 * between a URL and the group list if that guard is ever refactored.
 */
export const load: PageServerLoad = async ({ locals }) => {
	assertAdmin(locals.user);
	const [list, kbs] = await Promise.all([groups(), knowledgeBases()]);
	return { groups: list, knowledgeBases: kbs, user: locals.user };
};
