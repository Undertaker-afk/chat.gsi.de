/**
 * Read-only Keycloak directory lookups.
 *
 * Deliberately a *separate* confidential client (`chat-gsi-de-admin`) holding
 * `view-users` and nothing that can write: the admin UI needs to list people who
 * have never logged in, and that is the entire reason this file exists. Roles
 * and group membership in Keycloak are never modified from here -- role changes
 * stay a Keycloak console job, and our own groups live in Postgres (plan.md §8b).
 *
 * If the service account is not configured the app still works; the user picker
 * simply falls back to the people who have logged in at least once.
 */
import { config } from './config';

export interface DirectoryUser {
	sub: string;
	username: string;
	name: string;
	email: string;
	enabled: boolean;
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string | null> {
	if (!config.keycloak.adminClientId || !config.keycloak.adminClientSecret) return null;
	if (token && token.expiresAt > Date.now() + 10_000) return token.value;

	const res = await fetch(
		`${config.keycloak.baseUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'client_credentials',
				client_id: config.keycloak.adminClientId,
				client_secret: config.keycloak.adminClientSecret
			})
		}
	);
	if (!res.ok) {
		throw new Error(`keycloak token request failed: ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as { access_token: string; expires_in: number };
	token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
	return token.value;
}

/** Realm users matching `search` (username, first/last name or email). */
export async function directory(search = '', max = 50): Promise<DirectoryUser[]> {
	const bearer = await accessToken();
	if (!bearer) return [];

	const url = new URL(`${config.keycloak.baseUrl}/admin/realms/${config.keycloak.realm}/users`);
	url.searchParams.set('max', String(max));
	url.searchParams.set('briefRepresentation', 'true');
	if (search) url.searchParams.set('search', search);

	const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
	if (!res.ok) throw new Error(`keycloak user list failed: ${res.status}`);

	const users = (await res.json()) as Array<Record<string, string | boolean>>;
	return (
		users
			// Service accounts are not people; they must never appear in a picker.
			.filter((u) => !String(u.username ?? '').startsWith('service-account-'))
			.map((u) => ({
				sub: String(u.id),
				username: String(u.username ?? ''),
				name: [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.username ?? ''),
				email: String(u.email ?? ''),
				enabled: u.enabled !== false
			}))
	);
}

export const directoryConfigured = () =>
	Boolean(config.keycloak.adminClientId && config.keycloak.adminClientSecret);
