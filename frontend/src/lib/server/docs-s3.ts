/**
 * Seed the repo docs into S3 so they are served from object storage instead of
 * the local filesystem. Large markdown files stream efficiently from SeaweedFS;
 * the filesystem read + text() response was the bottleneck for big docs.
 *
 * Seeding is idempotent and lazy: it runs once on the first doc content request
 * after boot, and skips on subsequent calls because a marker key exists.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { ensureBucketOnce, putObject, getObject } from './s3';
import { log } from './log';

const DOCS_DIR = join(process.cwd(), 'docs-content');
const S3_PREFIX = 'docs';
const SEED_MARKER = `${S3_PREFIX}/.seeded`;

let seeded: Promise<void> | null = null;

/** Walk docs-content/ and upload every .md file to S3 under docs/. */
async function seed(): Promise<void> {
	await ensureBucketOnce();

	const marker = await getObject(SEED_MARKER);
	if (marker) return; // already seeded

	if (!existsSync(DOCS_DIR)) {
		log.warn('docs-content dir not found, skipping S3 seed', { kind: 'docs' });
		return;
	}

	let count = 0;
	const categories = readdirSync(DOCS_DIR, { withFileTypes: true }).filter((e) =>
		e.isDirectory()
	);

	for (const cat of categories) {
		const catDir = join(DOCS_DIR, cat.name);
		const files = readdirSync(catDir, { withFileTypes: true }).filter(
			(f) => f.isFile() && f.name.endsWith('.md')
		);
		for (const f of files) {
			const key = `${S3_PREFIX}/${cat.name}/${f.name}`;
			const content = readFileSync(join(catDir, f.name));
			await putObject(key, content, 'text/markdown; charset=utf-8');
			count++;
		}
	}

	// Write the marker last so a partial seed (crash mid-upload) retries on next boot.
	await putObject(SEED_MARKER, Buffer.from(String(Date.now())), 'text/plain');

	log.info('docs seeded to s3', { kind: 'docs', count });
}

/** Trigger seeding at most once per process. Safe to call on every request. */
export function seedOnce(): Promise<void> {
	return (seeded ??= seed().catch((err) => {
		seeded = null;
		log.error('docs s3 seed failed', { kind: 'docs', error: String(err) });
		throw err;
	}));
}

/** Read a single doc from S3. Returns null if not found. */
export async function getDocContent(relPath: string): Promise<string | null> {
	await seedOnce();
	const key = `${S3_PREFIX}/${relPath}`;
	const obj = await getObject(key);
	if (!obj) return null;
	return obj.body.toString('utf-8');
}
