<script lang="ts">
	/**
	 * The documents agent's trace line.
	 *
	 * Its own component rather than a row inside AgentTrace, because the two run
	 * on different schedules: AgentTrace exists only in deep mode, and this runs
	 * on every turn including fast ones.
	 *
	 * The "none" state is shown, not hidden. The agent searches external sources
	 * on every single question, so a reader who sees nothing cannot tell whether
	 * it looked and found nothing or never ran -- and "Indico has nothing on this"
	 * is a genuine, useful answer.
	 */
	import type { DocumentStep } from '$lib/chat.svelte';
	import { viewer, isViewableDocument } from '$lib/viewer.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FileSearchIcon from '@lucide/svelte/icons/file-search';
	import PresentationIcon from '@lucide/svelte/icons/presentation';
	import BookMarkedIcon from '@lucide/svelte/icons/book-marked';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import PanelRightIcon from '@lucide/svelte/icons/panel-right-open';

	let { documents }: { documents: DocumentStep } = $props();

	const ORIGINS = {
		indico: { label: 'Indico', icon: PresentationIcon },
		repository: { label: 'Repository', icon: BookMarkedIcon },
		'corpus-link': { label: 'Verlinkt', icon: LinkIcon }
	} as const;

	const sources = $derived(documents.sources ?? []);
	// Only the documents whose text we actually read. The rest are abstracts, and
	// conflating the two is the one thing this UI must not do.
	const readCount = $derived(sources.filter((s) => s.read).length);
</script>

{#if documents.state === 'searching'}
	<p class="text-muted-foreground flex items-center gap-2 text-sm">
		<Spinner class="size-3.5" />
		Externe Dokumente werden durchsucht …
	</p>
{:else if documents.state === 'none'}
	<p class="text-muted-foreground flex items-center gap-2 text-xs">
		<FileSearchIcon class="size-3.5 shrink-0" />
		{#if documents.searched}
			Keine passenden externen Dokumente ({documents.searched} geprüft)
		{:else}
			Keine externen Dokumente gefunden
		{/if}
	</p>
{:else}
	<Collapsible.Root class="bg-muted/40 rounded-lg border">
		<Collapsible.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" size="sm" class="w-full justify-start font-normal">
					<FileSearchIcon data-icon="inline-start" />
					Externe Dokumente
					<Badge variant="secondary" class="ml-1">{sources.length}</Badge>
					{#if readCount > 0}
						<span class="text-muted-foreground ml-1 text-xs">
							{readCount} gelesen
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
			<ul class="flex flex-col gap-1 px-2 pt-1 pb-2">
				{#each sources as source (source.marker)}
					{@const origin = ORIGINS[source.origin]}
					{@const inPanel = isViewableDocument(source.url)}
					<li>
						<!--
							A document we can render opens in the side panel, not a new tab.
							Losing the conversation to read a source is the wrong trade, and
							the panel is the only place a PDF or a deck loads at all --
							indico.gsi.de sends no CORS headers, so the bytes have to come
							through our own proxy either way.

							Anything else -- a repository record, an Indico event page -- is a
							web page and still opens in a tab, because there is nothing to
							render.
						-->
						<svelte:element
							this={inPanel ? 'button' : 'a'}
							role={inPanel ? 'button' : undefined}
							type={inPanel ? 'button' : undefined}
							href={inPanel ? undefined : source.url}
							target={inPanel ? undefined : '_blank'}
							rel={inPanel ? undefined : 'noopener noreferrer'}
							onclick={inPanel ? () => viewer.openDocument(source.url, source.title) : undefined}
							class="hover:bg-muted/60 group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
						>
							<Badge variant="secondary" class="mt-0.5 font-mono">{source.marker}</Badge>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-medium">{source.title}</span>
								<span
									class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
								>
									<span class="inline-flex items-center gap-1">
										<origin.icon class="size-3" />
										{origin.label}
									</span>
									{#if !source.read}
										<!-- repository.gsi.de blocks automated file access, so its
										     records are only ever an abstract. Saying so is the
										     difference between a source and a claim. -->
										<span class="text-amber-600 dark:text-amber-500">nur Metadaten</span>
									{/if}
									{#if source.context}
										<span class="min-w-0 truncate">{source.context}</span>
									{/if}
								</span>
							</span>
							{#if inPanel}
								<PanelRightIcon
									class="text-muted-foreground mt-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
								/>
							{:else}
								<ExternalLinkIcon
									class="text-muted-foreground mt-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
								/>
							{/if}
						</svelte:element>
					</li>
				{/each}
			</ul>
		</Collapsible.Content>
	</Collapsible.Root>
{/if}
