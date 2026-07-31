/**
 * Doc tree and content, read from the docs-content/ directory that the
 * Containerfile copies from the repo-root docs/.
 *
 * The tree is flat — files grouped by their top-level directory (user,
 * developer, executive) — because the actual directory structure is
 * two levels deep and a nested tree adds no signal.
 */
import { getDocContent } from './docs-s3';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename, dirname, relative } from 'path';

const DOCS_ROOT = join(process.cwd(), 'docs-content');

export interface DocFile {
	/** Path relative to docs-content/ (e.g. "user/getting-started.md"). */
	path: string;
	/** Display title: the first `# ` heading, or the filename minus extension. */
	title: string;
	/** Category (top-level directory name, e.g. "user"). */
	category: string;
}

export interface DocTree {
	categories: { name: string; label: string; files: DocFile[] }[];
}

const CATEGORY_LABELS: Record<string, string> = {
	user: 'User guide',
	developer: 'Developer',
	executive: 'Executive'
};

function discover(): DocTree {
	const cats: DocTree['categories'] = [];

	if (!existsSync(DOCS_ROOT)) {
		return { categories: cats };
	}

	const entries = readdirSync(DOCS_ROOT, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const catName = entry.name;
		const catDir = join(DOCS_ROOT, catName);
		const files = readdirSync(catDir, { withFileTypes: true })
			.filter((f) => f.isFile() && f.name.endsWith('.md'))
			.map((f) => {
				const fullPath = join(catDir, f.name);
				const relPath = `${catName}/${f.name}`;
				const raw = readFileSync(fullPath, 'utf-8');
				const heading = raw.match(/^#\s+(.+)$/m);
				const title = heading ? heading[1] : basename(f.name, '.md');
				return { path: relPath, title, category: catName } satisfies DocFile;
			})
			.sort((a, b) => a.title.localeCompare(b.title));

		if (files.length > 0) {
			cats.push({
				name: catName,
				label: CATEGORY_LABELS[catName] ?? catName,
				files
			});
		}
	}

	// Consistent order.
	const order = ['user', 'developer', 'executive'];
	cats.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

	return { categories: cats };
}

/** The doc tree, computed once at startup. */
let _tree: DocTree | null = null;
export function docTree(): DocTree {
	if (!_tree) _tree = discover();
	return _tree;
}

/** Read a single doc's markdown content from S3. */

export async function docContent(relPath: string): Promise<string | null> {
	return getDocContent(relPath);
}
