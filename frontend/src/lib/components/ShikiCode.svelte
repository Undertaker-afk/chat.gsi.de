<script lang="ts">
	/**
	 * Syntax-highlighted code block for chat answers.
	 *
	 * Two paths:
	 *
	 *   streaming — @shikijs/stream's ShikiStreamTokenizer, fed only the text that
	 *     arrived since the last update. A fence inside a streaming answer is
	 *     re-parsed by svelte-markdown on every SSE token, so highlighting the
	 *     whole block each time is quadratic in the block's length and repaints
	 *     every span; the tokenizer instead keeps its grammar state and emits just
	 *     the new tokens, recalling the few at the tail that the new text changed.
	 *
	 *   settled — one plain codeToTokens pass, which is both cheaper and exact
	 *     once the text has stopped moving.
	 *
	 * Renders Shiki's *tokens* as elements rather than passing its HTML through
	 * `{@html}`. Shiki escapes its own output, so `{@html}` would be defensible --
	 * but the answer path has no `{@html}` anywhere by design (see $lib/markdown),
	 * and keeping it that way means the rule needs no exceptions to reason about.
	 *
	 * Falls back to plain text until the highlighter resolves, so a slow grammar
	 * chunk never leaves the block blank.
	 */
	import { mode } from 'mode-watcher';
	import { getHighlighter, ensureLanguage, resolveLanguage, THEMES } from '$lib/shiki';
	import { getTokenStyleObject, stringifyTokenStyle, type ThemedToken } from 'shiki';
	import type { ShikiStreamTokenizer } from '@shikijs/stream';

	let {
		code,
		lang = '',
		streaming = false
	}: { code: string; lang?: string; streaming?: boolean } = $props();

	// $state.raw: these arrays are replaced wholesale, never mutated in place, and
	// a deep proxy over thousands of tokens is pure overhead.
	let tokens = $state.raw<ThemedToken[] | null>(null);

	const theme = $derived(mode.current === 'dark' ? THEMES.dark : THEMES.light);
	const language = $derived(resolveLanguage(lang));

	/**
	 * Incremental state. Held outside the effect so a growing `code` reuses the
	 * tokenizer; it is thrown away and rebuilt when the language or theme changes,
	 * or when the text stops being an append (an edit, a retry, a new answer).
	 */
	let tokenizer: ShikiStreamTokenizer | null = null;
	let consumed = '';
	let signature = '';

	function reset() {
		tokenizer = null;
		consumed = '';
		signature = '';
	}

	$effect(() => {
		const source = code;
		const wanted = language;
		const activeTheme = theme;
		const live = streaming;
		let cancelled = false;

		(async () => {
			try {
				const highlighter = await getHighlighter();
				const resolved = await ensureLanguage(highlighter, wanted);
				if (cancelled) return;

				const key = `${resolved}::${activeTheme}`;
				const appended = signature === key && source.startsWith(consumed);

				if (!live || !appended) {
					// Settled, or the text is not a continuation of what we tokenized.
					// Either way the incremental state is worthless.
					reset();
					if (!live) {
						const result = highlighter.codeToTokens(source, {
							lang: resolved,
							theme: activeTheme
						});
						// codeToTokens groups per line and drops the separators;
						// ShikiStreamTokenizer emits them as tokens. Both paths render from
						// one flat list, so the line breaks are put back here.
						if (!cancelled) tokens = joinLines(result.tokens);
						return;
					}
				}

				if (!tokenizer) {
					const { ShikiStreamTokenizer } = await import('@shikijs/stream');
					if (cancelled) return;
					tokenizer = new ShikiStreamTokenizer({
						highlighter,
						lang: resolved,
						theme: activeTheme
					});
					signature = key;
					consumed = '';
				}

				const delta = source.slice(consumed.length);
				if (!delta) return;

				await tokenizer.enqueue(delta);
				if (cancelled) return;
				consumed = source;
				// tokensUnstable is the tail the tokenizer may still revise once more
				// text arrives; showing it keeps the block current instead of lagging
				// a line behind the cursor.
				tokens = [...tokenizer.tokensStable, ...tokenizer.tokensUnstable];
			} catch {
				// Highlighting is decoration; the code still has to be readable.
				if (!cancelled) {
					reset();
					tokens = null;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	function joinLines(lines: ThemedToken[][]): ThemedToken[] {
		const flat: ThemedToken[] = [];
		lines.forEach((line, i) => {
			if (i > 0) flat.push({ content: '\n', offset: 0 } as ThemedToken);
			flat.push(...line);
		});
		return flat;
	}

	/**
	 * Shiki's own style serialiser rather than a hand-rolled one: it covers the
	 * FontStyle bitmask and the `htmlStyle` a theme may attach per token.
	 */
	const styleFor = (token: ThemedToken) =>
		stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token));
</script>

{#if tokens}
	<pre class="shiki-block"><code
			>{#each tokens as token, i (i)}<span style={styleFor(token)}>{token.content}</span>{/each}</code
		></pre>
{:else}
	<pre class="shiki-block"><code>{code}</code></pre>
{/if}
