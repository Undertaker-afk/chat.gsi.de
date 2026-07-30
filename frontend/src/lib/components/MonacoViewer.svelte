<script lang="ts">
	/**
	 * Read-only Monaco, for viewing generated code.
	 *
	 * Monaco is browser-only and is therefore imported dynamically inside
	 * onMount: a top-level import would be evaluated during SSR and during
	 * `vite build`'s server pass, where `self`, `window` and `document` do not
	 * exist.
	 *
	 * Only `editor.worker` is wired up, not the json/ts/css/html language
	 * workers. Those provide IntelliSense and validation, which a read-only
	 * viewer has no use for; syntax highlighting comes from Monarch tokenizers
	 * that run on the main thread. Skipping them keeps several megabytes out of
	 * the bundle.
	 */
	import { onMount, untrack } from 'svelte';
	import { mode } from 'mode-watcher';
	import {
		getHighlighter,
		ensureLanguage,
		resolveLanguage,
		monacoLanguageIds,
		THEMES
	} from '$lib/shiki';

	let {
		value,
		language = 'plaintext',
		class: className = ''
	}: { value: string; language?: string | null; class?: string } = $props();

	let host = $state<HTMLDivElement | null>(null);
	let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
	let monaco: typeof import('monaco-editor/editor/editor.api.js') | null = null;
	let ready = $state(false);

	const theme = $derived(mode.current === 'dark' ? THEMES.dark : THEMES.light);
	/** Shiki id, not the raw fence word -- see resolveLanguage. */
	const langId = $derived(resolveLanguage(language));

	onMount(() => {
		let disposed = false;

		(async () => {
			// Specifiers go through monaco's exports map ("./*.js" -> "./esm/vs/*.js"),
			// so it is `monaco-editor/editor/...`, NOT the `monaco-editor/esm/vs/...`
			// path older guides use -- that resolves to esm/vs/esm/vs/... and fails
			// to build.
			//
			// editor.api only, deliberately NOT the `monaco-editor` barrel: that also
			// pulls in the TypeScript/CSS/HTML/JSON language services and Vite emits
			// a worker chunk for each (ts.worker alone is 6.7 MB) for IntelliSense
			// nothing here uses.
			//
			// basic-languages is gone too. Shiki now does the tokenizing, and its
			// TextMate grammars cover far more than Monarch shipped -- which is the
			// whole point: ```slurm had no Monarch grammar and rendered grey.
			const [m, { shikiToMonaco }, highlighter, { default: EditorWorker }] = await Promise.all([
				import('monaco-editor/editor/editor.api.js'),
				import('@shikijs/monaco'),
				getHighlighter(),
				import('monaco-editor/editor/editor.worker.js?worker')
			]);
			if (disposed) return;

			// Monaco has to know an id exists before Shiki can bind a tokenizer to
			// it, and the language of *this* file may not be in the base set.
			const wanted = await ensureLanguage(highlighter, untrack(() => langId));
			if (disposed) return;
			for (const id of new Set([...monacoLanguageIds(), wanted])) {
				if (!m.languages.getLanguages().some((l) => l.id === id)) {
					m.languages.register({ id });
				}
			}
			shikiToMonaco(highlighter, m as never);

			// Vite resolves `?worker` to a constructor; returning one from getWorker
			// is the documented integration path and avoids the "Unexpected usage"
			// error that getWorkerUrl produces under Vite.
			(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
				getWorker: () => new EditorWorker()
			};

			monaco = m;
			editor = m.editor.create(host!, {
				value: untrack(() => value),
				language: wanted,
				readOnly: true,
				domReadOnly: true,
				automaticLayout: true,
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				renderLineHighlight: 'none',
				fontSize: 13,
				lineNumbersMinChars: 3,
				padding: { top: 12, bottom: 12 },
				scrollbar: { alwaysConsumeMouseWheel: false },
				theme: untrack(() => theme)
			});
			ready = true;
		})();

		return () => {
			disposed = true;
			editor?.getModel()?.dispose();
			editor?.dispose();
			editor = null;
		};
	});

	// Re-applied rather than recreated: swapping files or toggling the theme must
	// not tear down the editor and lose scroll position for no reason.
	$effect(() => {
		if (!ready || !editor || !monaco) return;
		const model = editor.getModel();
		if (!model) return;
		if (model.getValue() !== value) editor.setValue(value);

		// The grammar may not be loaded yet when the viewer switches to a file in a
		// language outside the base set, so it is fetched before the model flips.
		const target = langId;
		const m = monaco;
		(async () => {
			const highlighter = await getHighlighter();
			const resolved = await ensureLanguage(highlighter, target);
			if (!m.languages.getLanguages().some((l) => l.id === resolved)) {
				m.languages.register({ id: resolved });
			}
			const current = editor?.getModel();
			if (current) m.editor.setModelLanguage(current, resolved);
		})();
	});

	$effect(() => {
		if (ready && monaco) monaco.editor.setTheme(theme);
	});
</script>

<div class="relative {className}">
	<div bind:this={host} class="h-full w-full"></div>
	{#if !ready}
		<div
			class="text-muted-foreground bg-muted/30 absolute inset-0 flex items-center justify-center text-sm"
		>
			Editor wird geladen…
		</div>
	{/if}
</div>
