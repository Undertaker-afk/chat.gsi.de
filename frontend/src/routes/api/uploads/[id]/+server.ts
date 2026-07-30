import type { RequestHandler } from './$types';
import { json, error, redirect } from '@sveltejs/kit';
import { directLink, isAttachmentId, remove } from '$lib/server/uploads';

/**
 * Stable, session-guarded entry point for an upload.
 *
 * The session is validated here and the attachment is looked up scoped by
 * user_sub -- an id alone is not enough to reach someone else's file. Only then
 * do we hand out a presigned SeaweedFS URL, valid for S3_LINK_TTL_SECONDS (5
 * minutes by default). Messages store this /api/uploads/<id> path, so they never
 * embed a link that expires; the ephemeral URL is minted per request and the
 * bytes stream from storage instead of through Node.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	if (!isAttachmentId(params.id)) error(404, 'not found');

	const url = await directLink(params.id, locals.user.sub);
	if (!url) error(404, 'not found');

	// 302, not 301: the target is valid for minutes. Caching the redirect itself
	// would hand the browser a dead URL after it expires.
	redirect(302, url);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');
	const ok = await remove(params.id, locals.user.sub);
	if (!ok) error(404, 'not found');
	return json({ ok: true });
};
