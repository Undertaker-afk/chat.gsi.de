import { json } from '@sveltejs/kit';
import { sql } from '$lib/server/db';

export const GET = async () => {
	try {
		await sql`SELECT 1`;
		return json({ status: 'ok' });
	} catch (err) {
		return json({ status: 'degraded', error: String(err) }, { status: 503 });
	}
};
