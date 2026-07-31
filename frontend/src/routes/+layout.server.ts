import type { LayoutServerLoad } from './$types';
import { effectiveKbs } from '$lib/server/permissions';
import { getLanguage } from '$lib/server/preferences';
import { DEFAULT_LANGUAGE } from '$lib/language.svelte';

export const load: LayoutServerLoad = async ({ locals }) => ({
	user: locals.user,
	// The user's saved interface language, so the client store starts correct and
	// there is no flash of the default language on load.
	language: locals.user ? await getLanguage(locals.user.sub) : DEFAULT_LANGUAGE,
	// What this user's questions actually search. Shown in the composer so
	// "why does it not know about X?" has a visible answer (plan.md §8b).
	knowledgeBases: locals.user ? await effectiveKbs(locals.user.sub) : []
});
