import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { assertAdmin } from '$lib/server/permissions';
import { directory, directoryConfigured } from '$lib/server/keycloak';
import { sql } from '$lib/server/db';

/**
 * People the admin can put into a group.
 *
 * Two sources, merged: the Keycloak directory (so someone who has never logged
 * in can still be provisioned) and our own app_users mirror (so the picker keeps
 * working when the read-only service account is not configured, and so we can
 * show which roles a person actually holds).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	assertAdmin(locals.user);
	const search = (url.searchParams.get('q') ?? '').trim();
	const like = `%${search}%`;

	const seen = await sql<
		{ sub: string; username: string; name: string; email: string; roles: string[] }[]
	>`
		SELECT sub, coalesce(username, '') AS username, coalesce(name, '') AS name,
		       coalesce(email, '') AS email, roles
		  FROM app_users
		 WHERE ${
				search
					? sql`(username ILIKE ${like} OR name ILIKE ${like} OR email ILIKE ${like})`
					: sql`true`
			}
		 ORDER BY last_seen_at DESC LIMIT 50`;

	const byId = new Map(seen.map((u) => [u.sub, { ...u, enabled: true, everLoggedIn: true }]));

	let directoryError: string | null = null;
	if (directoryConfigured()) {
		try {
			for (const u of await directory(search)) {
				const known = byId.get(u.sub);
				byId.set(u.sub, { ...u, roles: known?.roles ?? [], everLoggedIn: Boolean(known) });
			}
		} catch (err) {
			// A directory outage must not take the admin page down: it degrades to
			// the people we have seen ourselves.
			directoryError = err instanceof Error ? err.message : 'directory unavailable';
		}
	}

	const users = [...byId.values()].sort((a, b) =>
		(a.name || a.username).localeCompare(b.name || b.username)
	);
	return json({ users, directory: directoryConfigured(), directoryError });
};
