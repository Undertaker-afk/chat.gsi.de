<script lang="ts">
	/**
	 * Renders one file, choosing the view from its mime type:
	 *
	 *   application/pdf   always rendered as a document (svelte-pdf / pdf.js)
	 *   text/markdown     rendered by default, with a switch to the source
	 *   everything else   read-only Monaco
	 *
	 * Markdown is the only type with two modes, because it is the only one where
	 * both views are genuinely useful: you read the prose, but you may want the
	 * exact syntax before copying it somewhere.
	 */
	import { browser } from '$app/environment';
	import SlideViewer from './SlideViewer.svelte';
	import SvelteMarkdown, { buildUnsupportedHTML } from '@humanspeak/svelte-markdown';
	import { prepareMarkdown } from '$lib/markdown';
	import MonacoViewer from './MonacoViewer.svelte';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import * as Alert from '$lib/components/ui/alert';
	import { Spinner } from '$lib/components/ui/spinner';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import CodeIcon from '@lucide/svelte/icons/code';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

	let {
		mime,
		filename,
		content = '',
		url,
		sourceUrl,
		language = null
	}: {
		mime: string;
		filename: string;
		/** Text content. Unused for PDFs, which stream from `url`. */
		content?: string;
		/** Source for binary types (PDF). */
		url?: string;
		/** Original address behind `url`, shown as a fallback link when a PDF fails. */
		sourceUrl?: string;
		language?: string | null;
	} = $props();

	const isPdf = $derived(mime === 'application/pdf');
	// Presentations get the slide renderer; everything else Office-shaped has no
	// viewer here and falls through to the download/original link.
	const isSlides = $derived(
		mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
			mime === 'application/vnd.oasis.opendocument.presentation'
	);
	const isMarkdown = $derived(mime === 'text/markdown');

	let markdownMode = $state<'rendered' | 'source'>('rendered');

	// Same guard as the chat: every HTML tag renders as escaped text. See
	// $lib/markdown for why the escaping there is the primary defence.
	const htmlRenderers = buildUnsupportedHTML();
	const markdownOptions = { gfm: true, breaks: true };

	/**
	 * pdf.js touches the DOM at import time, so it is client-only. Held as one
	 * promise per component instance rather than `{#await import(...)}` inline,
	 * which re-issues the import expression on every re-render of that block.
	 */
	const pdfModule = browser ? import('svelte-pdf') : null;

	/**
	 * PDF bytes are fetched here rather than handed to svelte-pdf as a URL.
	 *
	 * pdf.js does its own fetch and reports a failure as "Unexpected server
	 * response (502)" -- which is what the user saw for a link whose host had
	 * gone away. Fetching first means /api/pdf's German error message reaches the
	 * screen, and the blob is a natural unload point when the document changes.
	 */
	let blobUrl = $state<string | null>(null);
	let pdfError = $state<string | null>(null);
	let pdfLoading = $state(false);

	$effect(() => {
		const target = url;
		if (!isPdf || !target || !browser) return;

		let cancelled = false;
		pdfError = null;
		pdfLoading = true;

		fetch(target)
			.then(async (res) => {
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					throw new Error(body?.message ?? `HTTP ${res.status}`);
				}
				const blob = await res.blob();
				if (cancelled) return;
				blobUrl = URL.createObjectURL(blob);
			})
			.catch((e) => {
				if (!cancelled) pdfError = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (!cancelled) pdfLoading = false;
			});

		return () => {
			cancelled = true;
			// Revoked on the way out, so switching documents releases the old one
			// instead of holding every PDF opened this session in memory.
			if (blobUrl) URL.revokeObjectURL(blobUrl);
			blobUrl = null;
		};
	});
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2">
	{#if isMarkdown}
		<ToggleGroup.Root
			type="single"
			variant="outline"
			size="sm"
			value={markdownMode}
			onValueChange={(v) => v && (markdownMode = v as 'rendered' | 'source')}
			class="justify-start"
		>
			<ToggleGroup.Item value="rendered" aria-label="Gerendert anzeigen">
				<EyeIcon data-icon="inline-start" />
				Gerendert
			</ToggleGroup.Item>
			<ToggleGroup.Item value="source" aria-label="Quelltext anzeigen">
				<CodeIcon data-icon="inline-start" />
				Quelltext
			</ToggleGroup.Item>
		</ToggleGroup.Root>
	{/if}

	{#if isSlides}
		{#if url}
			<SlideViewer {url} {sourceUrl} />
		{/if}
	{:else if isPdf}
		{#if pdfError}
			<Alert.Root variant="destructive">
				<TriangleAlertIcon />
				<Alert.Title>PDF konnte nicht geladen werden</Alert.Title>
				<Alert.Description class="flex flex-col items-start gap-2">
					<span>{pdfError}</span>
					{#if sourceUrl}
						<!-- Link rot is the usual cause, and the user is better placed than we
						     are to judge whether the original is worth chasing. -->
						<a
							href={sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 underline underline-offset-2"
						>
							<ExternalLinkIcon class="size-3.5" />
							Original öffnen
						</a>
					{/if}
				</Alert.Description>
			</Alert.Root>
		{:else if browser && pdfModule && blobUrl}
			<div class="min-h-0 flex-1 overflow-auto rounded-lg border">
				{#await pdfModule then Pdf}
					<!--
						Keyed on the blob so switching documents destroys the old viewer and
						builds a new one. Without this, svelte-pdf keeps the document it
						loaded on mount -- it reads `url` once -- and clicking a second PDF
						leaves the first one on screen.
					-->
					{#key blobUrl}
						<Pdf.default url={blobUrl} showButtons={['navigation', 'zoom', 'rotate', 'print']} />
					{/key}
				{:catch}
					<p class="text-muted-foreground p-4 text-sm">
						PDF-Betrachter konnte nicht geladen werden. Die Datei lässt sich weiterhin
						herunterladen.
					</p>
				{/await}
			</div>
		{:else}
			<div class="text-muted-foreground flex items-center gap-2 rounded-lg border p-4 text-sm">
				{#if pdfLoading}<Spinner class="size-4" />{/if}
				PDF wird geladen…
			</div>
		{/if}
	{:else if isMarkdown && markdownMode === 'rendered'}
		<div class="answer-prose min-h-0 flex-1 overflow-auto rounded-lg border p-4 text-sm">
			<SvelteMarkdown
				source={prepareMarkdown(content)}
				options={markdownOptions}
				renderers={{ html: htmlRenderers }}
			/>
		</div>
	{:else}
		<MonacoViewer
			value={content}
			language={isMarkdown ? 'markdown' : language}
			class="min-h-0 flex-1 overflow-hidden rounded-lg border"
		/>
	{/if}
</div>
