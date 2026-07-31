import type { PageServerLoad } from './$types';
import { docTree } from '$lib/server/docs';

export const load: PageServerLoad = async () => {
	return { tree: docTree() };
};
