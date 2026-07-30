import type { LayoutServerLoad } from './$types';
import { effectiveKbs } from '$lib/server/permissions';

export const load: LayoutServerLoad = async ({ locals }) => ({
	user: locals.user,
	// What this user's questions actually search. Shown in the composer so
	// "why does it not know about X?" has a visible answer (plan.md §8b).
	knowledgeBases: locals.user ? await effectiveKbs(locals.user.sub) : []
});
