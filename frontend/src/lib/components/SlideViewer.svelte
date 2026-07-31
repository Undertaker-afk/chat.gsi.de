<script lang="ts">
	/**
	 * Renders a .pptx / .odp in the panel, via pptxviewjs.
	 *
	 * Its own component rather than another branch inside FileViewer for the same
	 * reason svelte-pdf is loaded lazily there: the library touches the DOM and
	 * pulls in a renderer, so it must stay client-only and out of the server
	 * bundle. Keeping it separate also means FileViewer's PDF path is unaffected
	 * when this fails to load.
	 *
	 * pptxviewjs draws ONE slide to a canvas at a time -- there is no scrolling
	 * document view -- so paging is ours to provide. That is why this looks more
	 * like a slideshow than the PDF branch does.
	 *
	 * The bytes come from `url`, always our own /api/pdf proxy: Indico sends no
	 * CORS headers, so a direct cross-origin fetch is blocked exactly as it is for
	 * PDFs. `loadFromUrl` would do its own fetch and hit that wall.
	 */
	import { browser } from '$app/environment';
import { t } from '$lib/language.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Alert from '$lib/components/ui/alert';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	let { url, sourceUrl }: { url: string; sourceUrl?: string } = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let slide = $state(0);
	let count = $state(0);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let instance: any = null;

	$effect(() => {
		const target = canvas;
		const source = url;
		if (!browser || !target || !source) return;

		let cancelled = false;
		error = null;
		loading = true;
		instance = null;
		slide = 0;
		count = 0;

		(async () => {
			try {
				const response = await fetch(source);
				if (!response.ok) {
					// The proxy answers with a readable German message; a bare status
					// code would tell the user nothing about link rot.
					throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`);
				}
				const bytes = await response.arrayBuffer();
				if (cancelled) return;

				const { PPTXViewer } = await import('pptxviewjs');
				if (cancelled) return;

				const viewer = new PPTXViewer();
				await viewer.loadFile(bytes);
				if (cancelled) return;

				await viewer.render(target);
				if (cancelled) return;

				instance = viewer;
				count = viewer.getSlideCount();
				slide = viewer.getCurrentSlideIndex();
			} catch (e) {
				if (!cancelled) error = e instanceof Error ? e.message : String(e);
			} finally {
				if (!cancelled) loading = false;
			}
		})();

		return () => {
			cancelled = true;
			instance = null;
		};
	});

	async function go(index: number) {
		if (!instance || !canvas || index < 0 || index >= count) return;
		await instance.goToSlide(index, canvas);
		slide = instance.getCurrentSlideIndex();
	}
</script>

{#if error}
	<Alert.Root variant="destructive">
		<TriangleAlertIcon />
		<Alert.Title>{t('slideViewer.errorTitle')}</Alert.Title>
		<Alert.Description class="flex flex-col items-start gap-2">
			<span>{error}</span>
			{#if sourceUrl}
				<!-- Slide rendering is best-effort: a deck with unusual embedded media
				     may not render, and the original always will. -->
				<a
					href={sourceUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1 underline underline-offset-2"
				>
					<ExternalLinkIcon class="size-3.5" />
					{t('slideViewer.openOriginal')}
				</a>
			{/if}
		</Alert.Description>
	</Alert.Root>
{:else}
	<div class="flex min-h-0 flex-1 flex-col gap-2">
		<div class="relative min-h-0 flex-1 overflow-auto rounded-lg border">
			{#if loading}
				<div class="text-muted-foreground absolute inset-0 flex items-center gap-2 p-4 text-sm">
					<Spinner class="size-4" />
					{t('slideViewer.loading')}
				</div>
			{/if}
			<canvas bind:this={canvas} class="h-auto w-full"></canvas>
		</div>

		{#if count > 1}
			<div class="flex items-center justify-center gap-2">
				<Button
					variant="ghost"
					size="icon"
					aria-label={t('slideViewer.previousSlide')}
					disabled={slide <= 0}
					onclick={() => go(slide - 1)}
				>
					<ChevronLeftIcon />
				</Button>
				<span class="text-muted-foreground text-xs tabular-nums">
					{t('slideViewer.slideCounter', { current: slide + 1, total: count })}
				</span>
				<Button
					variant="ghost"
					size="icon"
					aria-label={t('slideViewer.nextSlide')}
					disabled={slide >= count - 1}
					onclick={() => go(slide + 1)}
				>
					<ChevronRightIcon />
				</Button>
			</div>
		{/if}
	</div>
{/if}
