import type { RequestHandler } from './$types';
import { json, error, text } from '@sveltejs/kit';
import { docTree, docContent } from '$lib/server/docs';

/** List doc categories and files, or return a single doc's raw markdown. */
export const GET: RequestHandler = async ({ url }) => {
	const file = url.searchParams.get('file');

	if (file) {
		const content = await docContent(file);
		if (content === null) error(404, 'Document not found');
		// Raw markdown — no JSON wrapper. Large docs stream efficiently
		// and the client reads response.text() directly.
		return text(content);
	}

	return json(docTree());
};
