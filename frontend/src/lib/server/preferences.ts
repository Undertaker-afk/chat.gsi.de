/**
 * Per-user interface preferences that live in the database rather than the token.
 *
 * The only one today is language. It is stored on app_users (migration 020) and
 * read on every layout load so the server can render the UI in the user's
 * language and the client store can start from it.
 */
import { sql } from './db';
import { DEFAULT_LANGUAGE, isLanguage, type Language } from '$lib/language.svelte';

/** The user's saved language, or the default if unset/unknown/not yet mirrored. */
export async function getLanguage(userSub: string): Promise<Language> {
	const [row] = await sql<{ language: string }[]>`
		SELECT language FROM app_users WHERE sub = ${userSub}`;
	return row && isLanguage(row.language) ? row.language : DEFAULT_LANGUAGE;
}

/** Persist the user's language choice. Ignores unknown codes. */
export async function setLanguage(userSub: string, language: Language): Promise<void> {
	if (!isLanguage(language)) return;
	await sql`UPDATE app_users SET language = ${language} WHERE sub = ${userSub}`;
}
