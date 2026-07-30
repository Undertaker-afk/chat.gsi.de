/**
 * One Shiki highlighter, shared by the chat code blocks and the Monaco viewer.
 *
 * Shiki replaced Monaco's Monarch tokenizers because Monarch only covers the
 * grammars monaco-editor ships, and the model writes fences for things it does
 * not have -- ```slurm rendered as plain grey text in the side panel. Shiki
 * carries the full TextMate grammar set, and anything missing can be loaded at
 * runtime from `bundledLanguages`.
 *
 * Client-only: creating a highlighter loads WASM and grammar chunks.
 */
import {
	createHighlighter,
	bundledLanguages,
	type BundledLanguage,
	type Highlighter,
	type SpecialLanguage
} from 'shiki';

/** Shiki theme ids, also used verbatim as Monaco theme names. */
export const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/**
 * Loaded up front. Everything else is fetched on demand by ensureLanguage(),
 * so a rarely-used grammar costs nothing until somebody pastes one.
 */
const BASE_LANGUAGES = [
	'bash',
	'python',
	'javascript',
	'typescript',
	'json',
	'yaml',
	'sql',
	'c',
	'cpp',
	'rust',
	'go',
	'java',
	'xml',
	'html',
	'css',
	'ini',
	'docker',
	'markdown',
	'diff',
	'make',
	'perl',
	'lua',
	'powershell'
];

/**
 * Fence info strings the model writes that are not Shiki language ids.
 *
 * `slurm` is the one that actually bit us: a Slurm batch script is a shell
 * script with #SBATCH comments, and no highlighter has a grammar by that name.
 */
const ALIASES: Record<string, string> = {
	slurm: 'bash',
	sbatch: 'bash',
	sh: 'bash',
	zsh: 'bash',
	shell: 'bash',
	console: 'bash',
	terminal: 'bash',
	py: 'python',
	js: 'javascript',
	ts: 'typescript',
	yml: 'yaml',
	dockerfile: 'docker',
	md: 'markdown',
	text: 'text',
	txt: 'text',
	plaintext: 'text',
	'': 'text'
};

let pending: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
	return (pending ??= createHighlighter({
		themes: [THEMES.light, THEMES.dark],
		langs: BASE_LANGUAGES
	}).catch((err) => {
		// Do not poison the singleton: a transient chunk-load failure should not
		// leave every later call rejecting forever.
		pending = null;
		throw err;
	}));
}

/** Map a fence info string onto a Shiki language id, or 'text'. */
export function resolveLanguage(raw: string | null | undefined): string {
	const key = (raw ?? '').trim().toLowerCase();
	if (key in ALIASES) return ALIASES[key];
	return key in bundledLanguages ? key : 'text';
}

/**
 * Guarantee `lang` is loaded. Safe to call repeatedly; Shiki no-ops when the
 * grammar is already registered.
 */
export async function ensureLanguage(
	highlighter: Highlighter,
	lang: string
): Promise<BundledLanguage | SpecialLanguage> {
	if (lang === 'text') return 'text';
	if (highlighter.getLoadedLanguages().includes(lang)) return lang as BundledLanguage;
	if (!(lang in bundledLanguages)) return 'text';
	try {
		await highlighter.loadLanguage(lang as BundledLanguage);
		return lang as BundledLanguage;
	} catch {
		return 'text';
	}
}

/** Every language id Monaco has to be told about before shikiToMonaco runs. */
export const monacoLanguageIds = () => [...BASE_LANGUAGES, 'text'];
