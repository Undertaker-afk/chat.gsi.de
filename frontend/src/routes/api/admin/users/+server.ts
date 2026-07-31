import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { assertAdmin } from '$lib/server/permissions';
import { directory, directoryConfigured } from '$lib/server/keycloak';
import { sql } from '$lib/server/db';

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

	// Per-user storage stats in one round-trip.
	const stats = await sql<
		{ sub: string; uploads: string; upload_bytes: string; generated: string; generated_bytes: string; conversations: number }[]
	>`
		SELECT u.sub,
		       coalesce((SELECT count(*) FROM attachments a WHERE a.user_sub = u.sub), 0)::text AS uploads,
		       coalesce((SELECT sum(bytes)  FROM attachments a WHERE a.user_sub = u.sub), 0)::text AS upload_bytes,
		       coalesce((SELECT count(*) FROM generated_files g WHERE g.user_sub = u.sub), 0)::text AS generated,
		       coalesce((SELECT sum(bytes)  FROM generated_files g WHERE g.user_sub = u.sub), 0)::text AS generated_bytes,
		       (SELECT count(*) FROM conversations c WHERE c.user_sub = u.sub)::int AS conversations
		  FROM app_users u
		 WHERE u.sub = ANY(${seen.map((s) => s.sub)})
	`;

	const statsBySub = new Map(stats.map((s) => [s.sub, s]));

	const byId = new Map(
		seen.map((u) => {
			const s = statsBySub.get(u.sub);
			return [u.sub, {
				...u,
				enabled: true,
				everLoggedIn: true,
				uploads: Number(s?.uploads ?? 0),
				uploadBytes: Number(s?.upload_bytes ?? 0),
				generatedFiles: Number(s?.generated ?? 0),
				generatedBytes: Number(s?.generated_bytes ?? 0),
				conversations: s?.conversations ?? 0
			}];
		})
	);

	let directoryError: string | null = null;
	if (directoryConfigured()) {
		try {
			for (const u of await directory(search)) {
				const known = byId.get(u.sub);
				if (known) {
					byId.set(u.sub, { ...u, ...known });
				} else {
					byId.set(u.sub, {
						...u,
						roles: [],
						everLoggedIn: false,
						uploads: 0,
						uploadBytes: 0,
						generatedFiles: 0,
						generatedBytes: 0,
						conversations: 0
					});
				}
			}
		} catch (err) {
			directoryError = err instanceof Error ? err.message : 'directory unavailable';
		}
	}

	const users = [...byId.values()].sort((a, b) =>
		(a.name || a.username).localeCompare(b.name || b.username)
	);
	return json({ users, directory: directoryConfigured(), directoryError });
};
