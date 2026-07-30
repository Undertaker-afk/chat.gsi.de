/**
 * Server-side sessions in Valkey, keyed by an opaque cookie.
 *
 * The cookie carries a random id and nothing else — no user data, no tokens, no
 * claims. Everything of value stays server-side, so a stolen cookie is revocable
 * by deleting one key.
 */
import { createClient } from 'redis';
import { randomBytes } from 'node:crypto';
import { config } from './config';
import { log } from './log';
import type { PendingAuth, Tokens } from './oidc';

export const SESSION_COOKIE = 'gsi_session';
export const PENDING_COOKIE = 'gsi_auth_pending';

const SESSION_TTL_S = 12 * 60 * 60;
const PENDING_TTL_S = 10 * 60;

// Created lazily for the same reason as the Postgres pool in db.ts: the build
// analysis imports this module with no VALKEY_URL in the environment.
let client: ReturnType<typeof createClient> | null = null;
let connecting: Promise<unknown> | null = null;

async function redis() {
	if (!client) {
		client = createClient({ url: config.valkey.url });
		// The generic RedisClientType does not surface EventEmitter methods.
		(client as unknown as { on(e: string, cb: (err: unknown) => void): void }).on('error', (err) =>
			log.error('valkey connection error', { kind: 'valkey', err })
		);
	}
	if (!client.isOpen) {
		connecting ??= client.connect();
		await connecting;
	}
	return client;
}

export interface Session extends Tokens {}

export interface User {
	sub: string;
	username: string;
	name: string;
	email: string;
	roles: string[];
}

export function newId(): string {
	return randomBytes(32).toString('base64url');
}

export async function put(id: string, session: Session): Promise<void> {
	const r = await redis();
	await r.set(`sess:${id}`, JSON.stringify(session), { EX: SESSION_TTL_S });
}

export async function get(id: string): Promise<Session | null> {
	const r = await redis();
	const raw = await r.get(`sess:${id}`);
	return raw ? (JSON.parse(raw) as Session) : null;
}

export async function destroy(id: string): Promise<void> {
	const r = await redis();
	await r.del(`sess:${id}`);
}

export async function putPending(id: string, pending: PendingAuth): Promise<void> {
	const r = await redis();
	await r.set(`pend:${id}`, JSON.stringify(pending), { EX: PENDING_TTL_S });
}

export async function takePending(id: string): Promise<PendingAuth | null> {
	const r = await redis();
	const raw = await r.get(`pend:${id}`);
	// Single-use: consumed on read, so a replayed callback cannot succeed twice.
	if (raw) await r.del(`pend:${id}`);
	return raw ? (JSON.parse(raw) as PendingAuth) : null;
}

/**
 * Session counts for /metrics.
 *
 * SCAN rather than KEYS: KEYS is O(n) and blocks the server for the duration,
 * and this runs on every Prometheus scrape. At lab scale both would finish
 * instantly; the point is that the shape stays correct when it does not.
 *
 * COUNT is a hint, not a page size, so the loop is the API — there is no
 * "give me the count" command for a pattern, by design.
 */
export async function sessionCount(): Promise<{ sessions: number; pending: number }> {
	const r = await redis();

	async function count(pattern: string): Promise<number> {
		let cursor = 0;
		let total = 0;
		do {
			const reply = await r.scan(cursor, { MATCH: pattern, COUNT: 1000 });
			cursor = Number(reply.cursor);
			total += reply.keys.length;
			// A cursor that keeps coming back non-zero on a growing keyspace could
			// loop for a long time; a scrape has a deadline, so cap the work.
			if (total > 100_000) break;
		} while (cursor !== 0);
		return total;
	}

	const [sessions, pending] = await Promise.all([count('sess:*'), count('pend:*')]);
	return { sessions, pending };
}

/** Valkey INFO, parsed into a flat map. Section headers (`# Memory`) are dropped. */
export async function valkeyInfo(): Promise<Record<string, string>> {
	const r = await redis();
	const raw = await r.info();
	const out: Record<string, string> = {};
	for (const rawLine of raw.split('\n')) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const at = trimmed.indexOf(':');
		if (at > 0) out[trimmed.slice(0, at)] = trimmed.slice(at + 1);
	}
	return out;
}

export function toUser(session: Session): User {
	return {
		sub: session.sub,
		username: session.username,
		name: session.name,
		email: session.email,
		roles: session.roles
	};
}
