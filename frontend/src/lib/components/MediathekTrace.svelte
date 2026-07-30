<script lang="ts">
	/**
	 * The image subagent's trace line, as its own collapsible block.
	 *
	 * It used to be a section inside AgentTrace, which put it under a "Recherche
	 * N/M" header counting research subagents it was not one of. Pulling it out
	 * matches the documents agent: one row per agent, each saying what it did.
	 *
	 * `none` is shown rather than hidden, for the same reason it is in
	 * DocumentTrace -- "looked and found nothing" and "never ran" must not look
	 * alike.
	 */
	import type { ImageStep } from '$lib/chat.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ImageIcon from '@lucide/svelte/icons/image';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';

	let { image }: { image: ImageStep } = $props();
</script>

{#if image.state === 'searching'}
	<p class="text-muted-foreground flex items-center gap-2 text-sm">
		<Spinner class="size-3.5" />
		Mediathek wird durchsucht …
	</p>
{:else if image.state === 'none'}
	<p class="text-muted-foreground flex items-center gap-2 text-xs">
		<ImageIcon class="size-3.5 shrink-0" />
		Kein passendes Bild gefunden
		{#if image.candidates}
			({image.candidates} geprüft)
		{/if}
	</p>
{:else}
	<Collapsible.Root class="bg-muted/40 rounded-lg border">
		<Collapsible.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" size="sm" class="w-full justify-start font-normal">
					<ImageIcon data-icon="inline-start" />
					Mediathek
					<Badge variant="secondary" class="ml-1">1</Badge>
					{#if image.candidates}
						<span class="text-muted-foreground ml-1 text-xs">
							{image.candidates} geprüft
						</span>
					{/if}
					<ChevronDownIcon
						data-icon="inline-end"
						class="ml-auto transition-transform group-data-[state=open]:rotate-180"
					/>
				</Button>
			{/snippet}
		</Collapsible.Trigger>

		<Collapsible.Content>
			<div class="flex flex-col gap-2 px-3 pt-1 pb-3">
				<a
					href={image.permalink ?? image.url}
					target="_blank"
					rel="noopener noreferrer"
					class="hover:bg-muted/60 group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors"
				>
					{#if image.url}
						<img
							src={image.url}
							alt={image.title ?? ''}
							class="h-12 w-16 shrink-0 rounded object-cover"
						/>
					{/if}
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{image.title}</span>
						{#if image.credit}
							<span class="text-muted-foreground block truncate text-xs">
								Bild: {image.credit}
							</span>
						{/if}
						{#if image.effectiveQuery}
							<!-- Only present when the search had to be broadened, so a less
							     specific picture than asked for is never silent. -->
							<span class="text-muted-foreground block truncate text-xs">
								Suche erweitert auf „{image.effectiveQuery}“
							</span>
						{/if}
					</span>
					<ExternalLinkIcon
						class="text-muted-foreground mt-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
					/>
				</a>
			</div>
		</Collapsible.Content>
	</Collapsible.Root>
{/if}
