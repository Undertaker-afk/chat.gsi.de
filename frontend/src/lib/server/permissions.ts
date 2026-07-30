/**
 * Delegated access control (plan.md §8b, db/migrations/008).
 *
 * Two levels of authority:
 *   - an ADMIN sets what a group may reach at most        (group_grants)
 *   - a MANAGER subdivides that per member, never beyond  (member_grants)
 *
 * Every check here is server-side and reads the live token roles. The UI hides
 * what a user may not do, but hiding is not enforcement -- `assertCanManage`
 * and the ceiling check in `setMemberGrants` are.
 */
import { error } from '@sveltejs/kit';
import { sql } from './db';
import type { User } from './session';

export const ROLE_USER = 'llmbot-user';
export const ROLE_PRIVILEGED = 'llmbot-privileged';
export const ROLE_ADMIN = 'llmbot-admin';

export interface KnowledgeBase {
	id: number;
	slug: string;
	label: string;
	web: string | null;
	is_default: boolean;
	source_slug: string;
	documents: number;
}

export const isAdmin = (user: { roles: string[] } | null | undefined) =>
	!!user?.roles.includes(ROLE_ADMIN);

export const isPrivileged = (user: { roles: string[] } | null | undefined) =>
	!!user?.roles.includes(ROLE_PRIVILEGED);

/*
 * A note on the ::int casts below.
 *
 * These ids are bigserial, and the driver hands bigint back as a STRING to
 * avoid precision loss. That is correct in general and wrong here: knowledge
 * base ids are compared against numbers all over the UI and the ceiling check,
 * and "3" !== 3 fails silently -- it once let a legitimate grant be rejected as
 * out of bounds. Casting in SQL keeps them numbers end to end.
 */

/** Every knowledge base, with how much is actually in it. */
export async function knowledgeBases(): Promise<KnowledgeBase[]> {
	return sql<KnowledgeBase[]>`
		SELECT kb.id::int, kb.slug, kb.label, kb.web, kb.is_default, s.slug AS source_slug,
		       count(d.id) FILTER (WHERE d.deleted_at IS NULL)::int AS documents
		  FROM knowledge_bases kb
		  JOIN sources s ON s.id = kb.source_id
		  LEFT JOIN documents d ON d.kb_id = kb.id
		 GROUP BY kb.id, s.slug
		 ORDER BY s.slug, kb.web NULLS FIRST`;
}

/**
 * The knowledge bases a user may search.
 *
 *   defaults ∪ for each group: restricted ? member_grants : group_grants
 *
 * A member starts with the group's full ceiling; `restricted` marks the ones a
 * manager has narrowed, so "no member_grants rows" means "not customised"
 * rather than "no access" -- see the column comment in 008.
 */
export async function effectiveKbIds(userSub: string): Promise<number[]> {
	const rows = await sql<{ id: number }[]>`
		SELECT id::int FROM knowledge_bases WHERE is_default
		UNION
		SELECT gg.kb_id::int AS id
		  FROM group_members gm
		  JOIN group_grants gg ON gg.group_id = gm.group_id
		 WHERE gm.user_sub = ${userSub} AND NOT gm.restricted
		UNION
		SELECT mg.kb_id::int AS id
		  FROM group_members gm
		  JOIN member_grants mg
		    ON mg.group_id = gm.group_id AND mg.user_sub = gm.user_sub
		  -- Intersected with the ceiling on read as well as on write: if an admin
		  -- narrows a group later, stale member rows must not keep access alive.
		  JOIN group_grants gg
		    ON gg.group_id = gm.group_id AND gg.kb_id = mg.kb_id
		 WHERE gm.user_sub = ${userSub} AND gm.restricted`;
	return rows.map((r) => r.id);
}

/** The same, with labels, for the composer footer and the settings dialog. */
export async function effectiveKbs(userSub: string): Promise<{ id: number; label: string }[]> {
	const ids = await effectiveKbIds(userSub);
	if (ids.length === 0) return [];
	return sql<{ id: number; label: string }[]>`
		SELECT id::int, label FROM knowledge_bases WHERE id = ANY(${ids}) ORDER BY label`;
}

// --- groups -----------------------------------------------------------------

export interface Group {
	id: number;
	name: string;
	description: string | null;
	members: number;
	managers: string[];
	kb_ids: number[];
}

export async function groups(): Promise<Group[]> {
	return sql<Group[]>`
		SELECT g.id::int, g.name, g.description,
		       count(DISTINCT gm.user_sub)::int AS members,
		       coalesce(array_agg(DISTINCT gm.user_sub)
		                FILTER (WHERE gm.is_manager), '{}') AS managers,
		       coalesce(array_agg(DISTINCT gg.kb_id)
		                FILTER (WHERE gg.kb_id IS NOT NULL), '{}')::int[] AS kb_ids
		  FROM groups g
		  LEFT JOIN group_members gm ON gm.group_id = g.id
		  LEFT JOIN group_grants  gg ON gg.group_id = g.id
		 GROUP BY g.id
		 ORDER BY g.name`;
}

/** Groups this user manages. Empty for everyone else, whatever roles they hold. */
export async function managedGroups(userSub: string): Promise<Group[]> {
	return sql<Group[]>`
		SELECT g.id::int, g.name, g.description,
		       count(DISTINCT gm2.user_sub)::int AS members,
		       coalesce(array_agg(DISTINCT gm2.user_sub)
		                FILTER (WHERE gm2.is_manager), '{}') AS managers,
		       coalesce(array_agg(DISTINCT gg.kb_id)
		                FILTER (WHERE gg.kb_id IS NOT NULL), '{}')::int[] AS kb_ids
		  FROM groups g
		  JOIN group_members me ON me.group_id = g.id
		                       AND me.user_sub = ${userSub} AND me.is_manager
		  LEFT JOIN group_members gm2 ON gm2.group_id = g.id
		  LEFT JOIN group_grants  gg  ON gg.group_id = g.id
		 GROUP BY g.id
		 ORDER BY g.name`;
}

export interface Member {
	user_sub: string;
	username: string | null;
	name: string | null;
	email: string | null;
	is_manager: boolean;
	restricted: boolean;
	kb_ids: number[];
}

export async function members(groupId: number): Promise<Member[]> {
	return sql<Member[]>`
		SELECT gm.user_sub, u.username, u.name, u.email, gm.is_manager, gm.restricted,
		       coalesce(array_agg(mg.kb_id) FILTER (WHERE mg.kb_id IS NOT NULL), '{}')::int[] AS kb_ids
		  FROM group_members gm
		  LEFT JOIN app_users u ON u.sub = gm.user_sub
		  LEFT JOIN member_grants mg
		         ON mg.group_id = gm.group_id AND mg.user_sub = gm.user_sub
		 WHERE gm.group_id = ${groupId}
		 GROUP BY gm.user_sub, u.username, u.name, u.email, gm.is_manager, gm.restricted
		 ORDER BY coalesce(u.name, u.username, gm.user_sub)`;
}

/** 403 unless the caller is privileged AND actually manages this group. */
export async function assertCanManage(user: User, groupId: number): Promise<void> {
	if (isAdmin(user)) return;
	if (!isPrivileged(user)) error(403, 'not allowed');
	const [row] = await sql`
		SELECT 1 FROM group_members
		 WHERE group_id = ${groupId} AND user_sub = ${user.sub} AND is_manager`;
	if (!row) error(403, 'not a manager of this group');
}

export function assertAdmin(user: User | null | undefined): asserts user is User {
	if (!isAdmin(user)) error(403, 'admin only');
}

// --- writes -----------------------------------------------------------------

export async function createGroup(actor: User, name: string, description: string | null) {
	const [row] = await sql<{ id: number }[]>`
		INSERT INTO groups (name, description, created_by)
		VALUES (${name}, ${description}, ${actor.sub}) RETURNING id::int`;
	await audit(actor, 'group.create', name, { groupId: row.id });
	return row.id;
}

export async function deleteGroup(actor: User, groupId: number) {
	const [row] = await sql<{ name: string }[]>`
		DELETE FROM groups WHERE id = ${groupId} RETURNING name`;
	if (!row) error(404, 'no such group');
	await audit(actor, 'group.delete', row.name, { groupId });
}

/** Admin-only: the ceiling. Narrowing it can strip access, so callers re-sweep. */
export async function setGroupGrants(actor: User, groupId: number, kbIds: number[]) {
	await sql.begin(async (tx) => {
		await tx`DELETE FROM group_grants WHERE group_id = ${groupId}`;
		if (kbIds.length) {
			await tx`INSERT INTO group_grants ${tx(
				kbIds.map((kb_id) => ({ group_id: groupId, kb_id })),
				'group_id',
				'kb_id'
			)}`;
		}
	});
	await audit(actor, 'grant.group', `group:${groupId}`, { kbIds });
}

export async function addMember(actor: User, groupId: number, userSub: string) {
	await sql`
		INSERT INTO group_members (group_id, user_sub, added_by)
		VALUES (${groupId}, ${userSub}, ${actor.sub})
		ON CONFLICT DO NOTHING`;
	await audit(actor, 'member.add', userSub, { groupId });
}

export async function removeMember(actor: User, groupId: number, userSub: string) {
	await sql`DELETE FROM group_members WHERE group_id = ${groupId} AND user_sub = ${userSub}`;
	await audit(actor, 'member.remove', userSub, { groupId });
}

/** Admin-only: who may manage this group's members. */
export async function setManager(
	actor: User,
	groupId: number,
	userSub: string,
	isManager: boolean
) {
	await sql`
		UPDATE group_members SET is_manager = ${isManager}
		 WHERE group_id = ${groupId} AND user_sub = ${userSub}`;
	await audit(actor, isManager ? 'member.promote' : 'member.demote', userSub, { groupId });
}

/**
 * Manager action: narrow a member to a subset of the group's ceiling.
 *
 * `kbIds === null` clears the customisation and returns the member to the full
 * ceiling. Anything outside the ceiling is rejected here rather than filtered
 * silently -- a manager asking for more than they may give is a bug or an
 * attack, and both deserve an error rather than a quietly different outcome.
 */
export async function setMemberGrants(
	actor: User,
	groupId: number,
	userSub: string,
	kbIds: number[] | null
) {
	const ceiling = await sql<{ kb_id: number }[]>`
		SELECT kb_id::int FROM group_grants WHERE group_id = ${groupId}`;
	const allowed = new Set(ceiling.map((r) => r.kb_id));

	if (kbIds) {
		const outside = kbIds.filter((id) => !allowed.has(id));
		if (outside.length) {
			error(403, `outside this group's access: ${outside.join(', ')}`);
		}
	}

	await sql.begin(async (tx) => {
		await tx`
			DELETE FROM member_grants WHERE group_id = ${groupId} AND user_sub = ${userSub}`;
		if (kbIds && kbIds.length) {
			await tx`INSERT INTO member_grants ${tx(
				kbIds.map((kb_id) => ({ group_id: groupId, user_sub: userSub, kb_id })),
				'group_id',
				'user_sub',
				'kb_id'
			)}`;
		}
		await tx`
			UPDATE group_members SET restricted = ${kbIds !== null}
			 WHERE group_id = ${groupId} AND user_sub = ${userSub}`;
	});

	await audit(actor, 'grant.member', userSub, { groupId, kbIds });
}

// --- audit ------------------------------------------------------------------

export async function audit(
	actor: User,
	action: string,
	target: string | null,
	detail: Record<string, unknown> = {}
) {
	// Cast at the boundary: the driver's JSONValue type cannot express "any
	// JSON-serialisable object", and every caller passes a plain literal.
	await sql`
		INSERT INTO audit_log (actor_sub, actor_name, action, target, detail)
		VALUES (${actor.sub}, ${actor.name ?? null}, ${action}, ${target},
		        ${sql.json(detail as never)})`;
}

export interface AuditEntry {
	id: number;
	at: string;
	actor_sub: string;
	actor_name: string | null;
	action: string;
	target: string | null;
	detail: Record<string, unknown>;
}

export async function auditLog(limit = 100): Promise<AuditEntry[]> {
	return sql<AuditEntry[]>`
		SELECT id, at, actor_sub, actor_name, action, target, detail
		  FROM audit_log ORDER BY at DESC LIMIT ${limit}`;
}

/** Remember who logged in, so the admin UI can show names next to subs. */
export async function rememberUser(user: User) {
	await sql`
		INSERT INTO app_users (sub, username, name, email, roles)
		VALUES (${user.sub}, ${user.username ?? null}, ${user.name ?? null},
		        ${user.email ?? null}, ${user.roles})
		ON CONFLICT (sub) DO UPDATE SET
			username = EXCLUDED.username,
			name = EXCLUDED.name,
			email = EXCLUDED.email,
			roles = EXCLUDED.roles,
			last_seen_at = now()`;
}
