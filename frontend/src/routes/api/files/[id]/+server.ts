import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { deleteGenerated, readGenerated } from '$lib/server/generated';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * File content for the viewer.
 *
 * Unlike /api/uploads/<id>, this returns the bytes through Node rather than
 * redirecting to a presigned URL: the viewer needs the text in hand to put it
 * into a Monaco model or render it as Markdown, and these are small text files
 * capped at MAX_GENERATED_BYTES. `?download=1` serves the same bytes as an
 * attachment instead.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) error(401, 'unauthenticated');
	if (!UUID.test(params.id)) error(404, 'not found');

	const found = await readGenerated(locals.user.sub, params.id);
	if (!found) error(404, 'not found');

	if (url.searchParams.get('download') === '1') {
		return new Response(found.content, {
			headers: {
				'content-type': `${found.file.mime}; charset=utf-8`,
				'content-disposition':
					`attachment; filename="${found.file.filename.replace(/[^\w.\- ]+/g, '_')}"`,
				// Private: this is one user's file behind a session check.
				'cache-control': 'private, no-store'
			}
		});
	}

	return json({ file: found.file, content: found.content });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	if (!UUID.test(params.id)) error(404, 'not found');
	if (!(await deleteGenerated(locals.user.sub, params.id))) error(404, 'not found');
	return json({ ok: true });
};
