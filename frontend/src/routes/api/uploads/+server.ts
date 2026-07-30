import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { list, store, ALLOWED_MIME } from '$lib/server/uploads';
import { QuotaExceeded, quotaMessage, usage } from '$lib/server/storage';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'unauthenticated');

	// `?limit=10` powers the composer's upload history; the settings dialog asks
	// for everything.
	const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
	const [items, storage] = await Promise.all([
		list(locals.user.sub, limit),
		usage(locals.user.sub)
	]);
	return json({ ...storage, items });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'unauthenticated');

	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File)) error(400, 'file is required');
	if (!ALLOWED_MIME.has(file.type)) error(415, `unsupported type: ${file.type || 'unknown'}`);

	try {
		const saved = await store(locals.user.sub, {
			name: file.name || null,
			mime: file.type,
			bytes: new Uint8Array(await file.arrayBuffer())
		});
		return json({
			id: saved.id,
			url: `/api/uploads/${saved.id}`,
			filename: saved.filename,
			bytes: saved.bytes,
			mime: saved.mime
		});
	} catch (err) {
		if (err instanceof QuotaExceeded) {
			// 413 so the client can show the quota message rather than a generic failure.
			error(413, quotaMessage(err.usage));
		}
		error(400, err instanceof Error ? err.message : 'upload failed');
	}
};
