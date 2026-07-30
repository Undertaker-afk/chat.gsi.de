import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { listGenerated } from '$lib/server/generated';
import { usage } from '$lib/server/storage';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	const [items, use] = await Promise.all([listGenerated(locals.user.sub), usage(locals.user.sub)]);
	return {
		items,
		storage: { generated: use.generated, used: use.used, quota: use.quota }
	};
};
