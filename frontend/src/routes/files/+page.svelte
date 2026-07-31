<script lang="ts">
	/**
	 * Generierte Dateien — what the assistant wrote and the user kept.
	 *
	 * Uses AdminShell for the same chrome as /admin and /management. Sections
	 * filter by kind rather than being separate pages, because the list is one
	 * flat set of files and switching kind should not lose the selection.
	 */
	import AdminShell from '$lib/components/AdminShell.svelte';
	import FileViewer from '$lib/components/FileViewer.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import * as Alert from '$lib/components/ui/alert';
	import FilesIcon from '@lucide/svelte/icons/files';
	import CodeIcon from '@lucide/svelte/icons/code';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FileIcon from '@lucide/svelte/icons/file';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { formatBytes, formatDate } from '$lib/format';
	import { t } from '$lib/language.svelte';

	let { data } = $props();

	interface Item {
		id: string;
		filename: string;
		mime: string;
		language: string | null;
		bytes: number;
		created_at: string;
		message_id: string | null;
	}

	// Seeded from the server load once; deletes mutate this list directly, so it
	// is plain state rather than $derived.
	// svelte-ignore state_referenced_locally
	let items = $state<Item[]>(data.items);
	let active = $state('all');
	// svelte-ignore state_referenced_locally
	let selectedId = $state<string | null>(data.items[0]?.id ?? null);
	let content = $state<string | null>(null);
	let loading = $state(false);
	let deleting = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	// Both panes collapse so the viewer can take the full width -- a Slurm script
	// or a PDF page is the thing worth the pixels, not the file list.
	let kindsOpen = $state(true);
	let listOpen = $state(true);

	const kindOf = (mime: string) =>
		mime === 'application/pdf' ? 'pdf' : mime === 'text/markdown' ? 'markdown' : 'code';

	const visible = $derived(active === 'all' ? items : items.filter((i) => kindOf(i.mime) === active));
	const selected = $derived(items.find((i) => i.id === selectedId) ?? null);

	// Keep the selection inside the filtered list, so switching kind never leaves
	// a file selected that is not on screen.
	$effect(() => {
		if (visible.length === 0) {
			selectedId = null;
		} else if (!visible.some((i) => i.id === selectedId)) {
			selectedId = visible[0].id;
		}
	});

	$effect(() => {
		const id = selectedId;
		if (!id) {
			content = null;
			return;
		}
		loading = true;
		content = null;
		fetch(`/api/files/${id}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const body = await res.json();
				// Ignore a response that arrived after the user moved on.
				if (selectedId === id) content = body.content;
			})
			.catch((e) => {
				errorMessage = t('files.loadError', { message: e.message });
			})
			.finally(() => {
				if (selectedId === id) loading = false;
			});
	});

	async function remove(id: string) {
		deleting = id;
		errorMessage = null;
		try {
			const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
			if (res.ok) {
				items = items.filter((i) => i.id !== id);
			} else {
				errorMessage = t('files.deleteFailed', { status: String(res.status) });
			}
		} finally {
			deleting = null;
		}
	}

	const ICONS = { code: CodeIcon, markdown: FileTextIcon, pdf: FileIcon };

	const SECTIONS = $derived([
		{ id: 'all', label: t('files.all'), icon: FilesIcon, description: t('files.fileCount', { count: items.length }) },
		{
			id: 'code',
			label: 'Code',
			icon: CodeIcon,
			description: `${items.filter((i) => kindOf(i.mime) === 'code').length}`
		},
		{
			id: 'markdown',
			label: 'Markdown',
			icon: FileTextIcon,
			description: `${items.filter((i) => kindOf(i.mime) === 'markdown').length}`
		},
		{
			id: 'pdf',
			label: 'PDF',
			icon: FileIcon,
			description: `${items.filter((i) => kindOf(i.mime) === 'pdf').length}`
		}
	]);
</script>

<svelte:head><title>{t('files.title')} · chat.gsi.de</title></svelte:head>

<AdminShell
	title={t('files.title')}
	subtitle={t('files.subtitle')}
	sections={SECTIONS}
	bind:active
	collapsibleSections
>
	{#if errorMessage}
		<Alert.Root variant="destructive">
			<TriangleAlertIcon />
			<Alert.Description>{errorMessage}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if items.length === 0}
		<Empty.Root class="py-12">
			<Empty.Header>
				<Empty.Media variant="icon"><FilesIcon /></Empty.Media>
				<Empty.Title>{t('files.noFiles')}</Empty.Title>
				<Empty.Description>
					{t('files.noFilesDescription')}
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<div
			class="grid min-h-0 gap-4 transition-[grid-template-columns] {listOpen
				? 'lg:grid-cols-[20rem_1fr]'
				: 'lg:grid-cols-[auto_1fr]'}"
		>
			{#if !listOpen}
				<!-- Collapsed: the control alone. Keeping the Card with a hidden body
				     left a full-height empty box sitting beside the viewer. -->
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
					<Card.Header class="flex-row items-start justify-between gap-2 space-y-0">
						<div class="flex min-w-0 flex-col gap-1">
							<Card.Title>{t('files.filesLabel')}</Card.Title>
							<Card.Description>
								{t('storage.usedOfQuota', { used: formatBytes(data.storage.generated), quota: formatBytes(data.storage.quota) })}
							</Card.Description>
						</div>
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
					<Card.Content class="flex max-h-[70vh] flex-col gap-1 overflow-y-auto">
					{#each visible as item (item.id)}
						{@const Icon = ICONS[kindOf(item.mime) as keyof typeof ICONS]}
						<button
							type="button"
							class="hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm
								{selectedId === item.id ? 'bg-muted font-medium' : ''}"
							onclick={() => (selectedId = item.id)}
						>
							<Icon class="text-muted-foreground size-4 shrink-0" />
							<span class="flex min-w-0 flex-1 flex-col">
								<span class="truncate">{item.filename}</span>
								<span class="text-muted-foreground text-xs">
									{formatBytes(item.bytes)} · {formatDate(item.created_at)}
								</span>
							</span>
						</button>
						{:else}
							<p class="text-muted-foreground py-2 text-sm">{t('files.nothingInCategory')}</p>
						{/each}
					</Card.Content>
				</Card.Root>
			{/if}

			<Card.Root class="flex min-h-0 flex-col">
				<Card.Header class="flex-row items-start justify-between gap-2 space-y-0">
					<div class="flex min-w-0 flex-col gap-1">
						<Card.Title class="truncate">{selected?.filename ?? t('files.noFileSelected')}</Card.Title>
						{#if selected}
							<div class="flex items-center gap-2">
								<Badge variant="secondary">{selected.mime}</Badge>
								{#if selected.language}
									<Badge variant="outline">{selected.language}</Badge>
								{/if}
							</div>
						{/if}
					</div>
					{#if selected}
						<div class="flex shrink-0 items-center gap-1">
							<Button
								variant="ghost"
								size="sm"
								href={`/api/files/${selected.id}?download=1`}
								download={selected.filename}
							>
								<DownloadIcon data-icon="inline-start" />
								{t('files.download')}
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="text-muted-foreground hover:text-destructive"
								aria-label={t('common.delete')}
								disabled={deleting === selected.id}
								onclick={() => selected && remove(selected.id)}
							>
								{#if deleting === selected.id}<Spinner />{:else}<Trash2Icon />{/if}
							</Button>
						</div>
					{/if}
				</Card.Header>
				<Card.Content class="flex min-h-[70vh] flex-col">
					{#if loading}
						<div class="text-muted-foreground flex items-center gap-2 py-6 text-sm">
							<Spinner class="size-4" /> {t('common.loading')}
						</div>
					{:else if selected && content !== null}
						<FileViewer
							mime={selected.mime}
							filename={selected.filename}
							language={selected.language}
							{content}
						/>
					{:else if !selected}
						<p class="text-muted-foreground text-sm">{t('files.selectFileHint')}</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	{/if}
</AdminShell>
