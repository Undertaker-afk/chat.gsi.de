<script lang="ts">
	/**
	 * Docs viewer — the files page's layout (sidebar + content pane), but the
	 * sidebar lists documentation instead of user files and the pane renders
	 * markdown instead of code/PDF.
	 */
	import SvelteMarkdown, { buildUnsupportedHTML } from '@humanspeak/svelte-markdown';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import { t } from '$lib/language.svelte';

	let { data } = $props();

	interface DocFile {
		path: string;
		title: string;
		category: string;
	}

	interface Category {
		name: string;
		label: string;
		files: DocFile[];
	}

	const categories: Category[] = data.tree?.categories ?? [];

	let selectedPath = $state<string | null>(null);
	let content = $state<string | null>(null);
	let loading = $state(false);
	let listOpen = $state(true);

	async function openDoc(path: string) {
		selectedPath = path;
		loading = true;
		content = null;
		try {
			const res = await fetch(`/api/docs?file=${encodeURIComponent(path)}`);
			if (res.ok) {
				content = await res.text();
			}
		} finally {
			loading = false;
		}
	}
	const htmlRenderers = buildUnsupportedHTML();
	const markdownOptions = { gfm: true, breaks: true };
</script>



<svelte:head><title>{t('page.help')} · chat.gsi.de</title></svelte:head>

<div class="flex h-dvh min-h-0 flex-col">
	<!-- Header -->
	<header class="bg-background/95 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur">
		<Button variant="ghost" size="sm" href="/" class="gap-1.5">
			<ChevronRightIcon class="size-4 rotate-180" />
			{t('adminShell.backToChat')}
		</Button>
		<span class="text-sm font-medium">{t('page.help')}</span>
	</header>

	<div class="flex min-h-0 flex-1">
		{#if categories.length === 0}
			<div class="flex flex-1 items-center justify-center">
				<Empty.Root>
					<Empty.Header>
						<Empty.Media variant="icon"><BookOpenIcon /></Empty.Media>
						<Empty.Title>{t('docs.empty')}</Empty.Title>
					</Empty.Header>
				</Empty.Root>
			</div>
		{:else}
			<div
				class="grid min-h-0 flex-1 gap-4 p-4 transition-[grid-template-columns] {listOpen
					? 'lg:grid-cols-[18rem_1fr]'
					: 'lg:grid-cols-[auto_1fr]'}"
			>
				<!-- Sidebar -->
				{#if !listOpen}
					<div class="self-start">
						<Button
							variant="ghost"
							size="icon"
							aria-label={t('files.expandList')}
							onclick={() => (listOpen = true)}
						>
							<PanelLeftOpenIcon />
						</Button>
					</div>
				{:else}
					<Card.Root class="min-h-0 self-start">
						<Card.Header class="flex-row items-center justify-between gap-2 space-y-0">
							<Card.Title>{t('docs.title')}</Card.Title>
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								aria-label={t('files.collapseList')}
								onclick={() => (listOpen = false)}
							>
								<PanelLeftCloseIcon />
							</Button>
						</Card.Header>
						<Card.Content class="flex max-h-[80vh] flex-col gap-1 overflow-y-auto">
							{#each categories as cat}
								<Collapsible.Root defaultOpen>
									<Collapsible.Trigger>
										{#snippet child({ props })}
											<button
												{...props}
												class="hover:bg-muted flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium"
											>
												<ChevronRightIcon class="size-3 transition-transform [[data-state=open]_&]:rotate-90" />
												{cat.label}
												<span class="text-muted-foreground ml-auto tabular-nums">{cat.files.length}</span>
											</button>
										{/snippet}
									</Collapsible.Trigger>
									<Collapsible.Content class="ml-3 flex flex-col gap-0.5">
										{#each cat.files as file}
											<button
												class="hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm
													{selectedPath === file.path ? 'bg-muted font-medium' : 'text-muted-foreground'}"
												onclick={() => openDoc(file.path)}
											>
												<FileTextIcon class="size-3.5 shrink-0" />
												<span class="truncate">{file.title}</span>
											</button>
										{/each}
									</Collapsible.Content>
								</Collapsible.Root>
							{/each}
						</Card.Content>
					</Card.Root>
				{/if}

				<!-- Content pane -->
				<Card.Root class="flex min-h-0 flex-col">
					<Card.Content class="min-h-[70vh] overflow-y-auto pt-6">
						{#if loading}
							<div class="text-muted-foreground flex items-center gap-2 py-6 text-sm">
								<Spinner class="size-4" /> {t('common.loading')}
							</div>
						{:else if content !== null}
							<div class="answer-prose text-foreground min-w-0 text-[0.95rem] leading-relaxed px-1">
								<SvelteMarkdown
									source={content}
									options={markdownOptions}
									renderers={{ html: htmlRenderers }}
								/>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			</div>
		{/if}
	</div>
</div>
