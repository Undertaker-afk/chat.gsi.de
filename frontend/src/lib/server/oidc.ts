/**
 * Keycloak OIDC: Authorization Code + PKCE, entirely server-side.
 *
 * Tokens never reach the browser. The browser holds one opaque session cookie;
 * the access token, refresh token and the GSI proxy key all stay in this process.
 */
import * as client from 'openid-client';
import { config } from './config';

let cached: client.Configuration | null = null;

export async function discover(): Promise<client.Configuration> {
	if (!cached) {
		const issuer = new URL(config.oidc.issuer);

		// openid-client v6 refuses plain HTTP by default, which is correct. Relax it
		// ONLY when the configured issuer is itself http:// -- i.e. the local dev
		// Keycloak. A production issuer of https://keycloak.gsi.de keeps full
		// transport enforcement, and there is no flag that can switch it off.
		const insecure = issuer.protocol === 'http:';
		if (insecure) {
			console.warn(
				`[oidc] issuer ${issuer.origin} is plain HTTP; TLS enforcement disabled (dev only)`
			);
		}

		cached = await client.discovery(
			issuer,
			config.oidc.clientId,
			config.oidc.clientSecret,
			undefined,
			insecure ? { execute: [client.allowInsecureRequests] } : undefined
		);
	}
	return cached;
}

export interface PendingAuth {
	codeVerifier: string;
	state: string;
	returnTo: string;
}

export async function authorizationUrl(returnTo: string): Promise<{
	url: string;
	pending: PendingAuth;
}> {
	const cfg = await discover();
	const codeVerifier = client.randomPKCECodeVerifier();
	const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
	const state = client.randomState();

	const url = client.buildAuthorizationUrl(cfg, {
		redirect_uri: config.oidc.redirectUri,
		scope: 'openid profile email',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state
	});

	return { url: url.href, pending: { codeVerifier, state, returnTo } };
}

export interface Tokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt: number;
	sub: string;
	username: string;
	name: string;
	email: string;
	roles: string[];
}

export async function exchange(currentUrl: URL, pending: PendingAuth): Promise<Tokens> {
	const cfg = await discover();
	try {
		const tokens = await client.authorizationCodeGrant(
			cfg,
			currentUrl,
			{ pkceCodeVerifier: pending.codeVerifier, expectedState: pending.state },
			// Sent explicitly. Left to the library it is derived from the incoming
			// request URL, which behind a proxy or with a rewritten Host does not
			// match the redirect_uri used in the authorization request -- Keycloak
			// then rejects the exchange with "invalid_grant: Incorrect redirect_uri".
			{ redirect_uri: config.oidc.redirectUri }
		);
		return toTokens(tokens);
	} catch (err) {
		// openid-client throws ResponseBodyError with the OAuth error in fields,
		// not in the message, so the default stack trace says nothing useful.
		// Surface it -- "invalid_grant: code already used" vs "invalid_client" are
		// completely different problems.
		const detail = err as { error?: string; error_description?: string };
		if (detail?.error) {
			console.error(
				`[oidc] token exchange rejected: ${detail.error}` +
					(detail.error_description ? ` - ${detail.error_description}` : '')
			);
			throw new Error(`OIDC token exchange failed: ${detail.error}`);
		}
		throw err;
	}
}

export async function refresh(refreshToken: string): Promise<Tokens> {
	const cfg = await discover();
	return toTokens(await client.refreshTokenGrant(cfg, refreshToken));
}

export async function endSessionUrl(idToken: string, postLogoutRedirect: string): Promise<string> {
	const cfg = await discover();
	return client.buildEndSessionUrl(cfg, {
		id_token_hint: idToken,
		post_logout_redirect_uri: postLogoutRedirect
	}).href;
}

function toTokens(
	response: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
): Tokens {
	// claims() comes from the response *helpers* and returns undefined when the
	// response carried no id_token.
	const claims = response.claims();
	if (!claims?.sub) throw new Error('OIDC response carried no subject claim');

	// Keycloak puts realm roles under realm_access.roles in the ACCESS token, not
	// the id token, so decode the access token rather than trusting claims alone.
	// The claim path is configurable (config.oidc.rolesClaim) for external IdPs,
	// and external role names are mapped to the app's canonical llmbot-* roles.
	const accessClaims = decodeJwtPayload(response.access_token);
	const roles = normalizeRoles(rolesFromClaims(accessClaims, claims));

	return {
		accessToken: response.access_token,
		refreshToken: response.refresh_token,
		idToken: response.id_token,
		expiresAt: Date.now() + (response.expires_in ?? 300) * 1000,
		sub: String(claims.sub),
		username: String(claims.preferred_username ?? claims.sub),
		name: String(claims.name ?? claims.preferred_username ?? claims.sub),
		email: String(claims.email ?? ''),
		roles
	};
}

function decodeJwtPayload(jwt: string): any {
	try {
		const [, payload] = jwt.split('.');
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
}

/** Follow a dotted path (`realm_access.roles`, `resource_access.app.roles`). */
function readClaimPath(obj: any, path: string): unknown {
	return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * The raw role list, from the configured claim path. Tries the access token
 * first (where Keycloak realm roles live) and falls back to the id token, so a
 * provider that only puts roles in the id token still works.
 */
function rolesFromClaims(accessClaims: any, idClaims: any): string[] {
	const path = config.oidc.rolesClaim;
	const raw = readClaimPath(accessClaims, path) ?? readClaimPath(idClaims, path);
	return Array.isArray(raw) ? raw.map(String) : [];
}

/**
 * Add the app's canonical role for every alias present, keeping the originals.
 *
 * `{ "llmbot-admin": ["admin"] }` means: a token carrying `admin` also counts as
 * `llmbot-admin` everywhere downstream (permissions.ts, the route guard), with
 * no other code aware that the realm calls it something else. Originals are kept
 * so the admin UI and stored roles still reflect what the IdP actually issued.
 */
function normalizeRoles(raw: string[]): string[] {
	const aliases = config.oidc.roleAliases;
	const roles = new Set(raw);
	for (const [canonical, externals] of Object.entries(aliases)) {
		if (externals.some((name) => roles.has(name))) roles.add(canonical);
	}
	return [...roles];
}
