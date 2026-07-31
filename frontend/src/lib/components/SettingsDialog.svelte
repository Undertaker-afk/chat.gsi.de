<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Empty from '$lib/components/ui/empty';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ImageIcon from '@lucide/svelte/icons/image';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { formatBytes, formatDate } from '$lib/format';
	import { t, language, setLanguage, LANGUAGES, type Language } from '$lib/language.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	interface Item {
		id: string;
		filename: string | null;
		mime: string;
		bytes: number;
		created_at: string;
		message_id: string | null;
	}

	let items = $state<Item[]>([]);
	let uploads = $state(0);
	let chats = $state(0);
	let generated = $state(0);
	let quota = $state(0);
	let loading = $state(false);
	let deleting = $state<string | null>(null);

	const used = $derived(uploads + chats + generated);
	const free = $derived(Math.max(0, quota - used));
	const percent = $derived(quota > 0 ? Math.min(100, (used / quota) * 100) : 0);
	/** Share of the bar, as a CSS width. Sub-percent slices still get a sliver. */
	const share = (n: number) => (quota > 0 && n > 0 ? `${Math.max(0.5, (n / quota) * 100)}%` : '0%');

	const currentLanguageLabel = $derived(
		LANGUAGES.find((l) => l.code === language())?.label ?? language()
	);

	/** Switch immediately (the store drives the whole UI), then persist. The save
	 *  is best-effort: the UI already changed, and a failed write just means the
	 *  choice does not survive the session, not a broken screen. */
	async function chooseLanguage(lang: Language) {
		if (lang === language()) return;
		setLanguage(lang);
		try {
			await fetch('/api/settings', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ language: lang })
			});
		} catch {
			/* ignore: language already applied client-side */
		}
	}

	// Load on open rather than on mount: no point querying storage for a dialog
	// the user never opens.
	$effect(() => {
		if (open) load();
	});

	async function load() {
		loading = true;
		try {
			const res = await fetch('/api/uploads');
			if (!res.ok) return;
			const data = await res.json();
			items = data.items ?? [];
			uploads = data.uploads ?? 0;
			chats = data.chats ?? 0;
			generated = data.generated ?? 0;
			quota = data.quota ?? 0;
		} finally {
			loading = false;
		}
	}

	async function remove(id: string) {
		deleting = id;
		try {
			const res = await fetch(`/api/uploads/${id}`, { method: 'DELETE' });
			if (res.ok) {
				const gone = items.find((i) => i.id === id);
				items = items.filter((i) => i.id !== id);
				if (gone) uploads -= gone.bytes;
			}
		} finally {
			deleting = null;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="px-6 pt-6 pb-4">
			<Dialog.Title>{t('settings.title')}</Dialog.Title>
			<Dialog.Description>{t('settings.description')}</Dialog.Description>
		</Dialog.Header>

		<Separator />

		<div class="flex flex-col gap-6 overflow-y-auto px-6 py-5">
			<!-- Theme -->
			<section class="flex flex-col gap-3">
				<div class="flex flex-col gap-0.5">
					<h3 class="text-sm font-medium">{t('theme.label')}</h3>
					<p class="text-muted-foreground text-xs">{t('theme.systemHint')}</p>
				</div>
				<ToggleGroup.Root
					type="single"
					variant="outline"
					value={userPrefersMode.current}
					onValueChange={(v) => v && setMode(v as 'light' | 'dark' | 'system')}
					class="justify-start"
				>
					<ToggleGroup.Item value="light" aria-label={t('theme.lightAria')}>
						<SunIcon data-icon="inline-start" />
						{t('theme.light')}
					</ToggleGroup.Item>
					<ToggleGroup.Item value="dark" aria-label={t('theme.darkAria')}>
						<MoonIcon data-icon="inline-start" />
						{t('theme.dark')}
					</ToggleGroup.Item>
					<ToggleGroup.Item value="system" aria-label={t('theme.systemAria')}>
						<MonitorIcon data-icon="inline-start" />
						{t('theme.system')}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</section>

			<Separator />

			<!-- Language -->
			<section class="flex flex-col gap-3">
				<div class="flex items-center justify-between gap-2">
					<div class="flex flex-col gap-0.5">
						<h3 class="flex items-center gap-1.5 text-sm font-medium">
							<LanguagesIcon class="size-3.5" />
							{t('language.label')}
						</h3>
						<p class="text-muted-foreground text-xs">{t('language.hint')}</p>
					</div>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="outline" size="sm" class="gap-1">
									{currentLanguageLabel}
									<ChevronDownIcon data-icon="inline-end" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-40">
							<DropdownMenu.Group>
								{#each LANGUAGES as lang (lang.code)}
									<DropdownMenu.Item onclick={() => chooseLanguage(lang.code)}>
										<span class="flex-1">{lang.label}</span>
										{#if language() === lang.code}
											<CheckIcon />
										{/if}
									</DropdownMenu.Item>
								{/each}
							</DropdownMenu.Group>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
			</section>

			<Separator />

			<!-- Storage -->
			<section class="flex flex-col gap-3">
				<div class="flex items-baseline justify-between gap-2">
					<div class="flex flex-col gap-0.5">
						<h3 class="flex items-center gap-1.5 text-sm font-medium">
							<HardDriveIcon class="size-3.5" />
							{t('storage.title')}
						</h3>
						<p class="text-muted-foreground text-xs">
							{t('storage.usedOfQuota', { used: formatBytes(used), quota: formatBytes(quota) })}
						</p>
					</div>
					<span class="text-muted-foreground text-xs tabular-nums">
						{percent.toFixed(percent < 1 && percent > 0 ? 2 : 0)}%
					</span>
				</div>

				<!--
					Stacked bar rather than <Progress>: the quota is shared, so what
					matters is the split between uploads and chats, not one total. The
					track itself is the free remainder.
				-->
				<div
					class="bg-muted flex h-2.5 w-full overflow-hidden rounded-full"
					role="img"
					aria-label={t('storage.barAria', {
						uploads: formatBytes(uploads),
						chats: formatBytes(chats),
						generated: formatBytes(generated),
						free: formatBytes(free)
					})}
				>
					<div class="bg-orange-500 transition-[width]" style:width={share(uploads)}></div>
					<div class="bg-emerald-500 transition-[width]" style:width={share(chats)}></div>
					<div class="bg-sky-500 transition-[width]" style:width={share(generated)}></div>
				</div>

				<dl class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
					<div class="flex items-center gap-1.5">
						<span class="size-2 rounded-full bg-orange-500"></span>
						<dt class="text-muted-foreground">{t('storage.uploads')}</dt>
						<dd class="tabular-nums">{formatBytes(uploads)}</dd>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="size-2 rounded-full bg-emerald-500"></span>
						<dt class="text-muted-foreground">{t('storage.chats')}</dt>
						<dd class="tabular-nums">{formatBytes(chats)}</dd>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="size-2 rounded-full bg-sky-500"></span>
						<dt class="text-muted-foreground">{t('storage.generated')}</dt>
						<dd class="tabular-nums">{formatBytes(generated)}</dd>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="bg-muted-foreground/25 size-2 rounded-full"></span>
						<dt class="text-muted-foreground">{t('storage.free')}</dt>
						<dd class="tabular-nums">{formatBytes(free)}</dd>
					</div>
				</dl>

				{#if loading}
					<div class="text-muted-foreground flex items-center gap-2 py-4 text-sm">
						<Spinner class="size-4" />
						{t('common.loading')}
					</div>
				{:else if items.length === 0}
					<Empty.Root class="py-6">
						<Empty.Header>
							<Empty.Media variant="icon">
								<ImageIcon />
							</Empty.Media>
							<Empty.Title>{t('storage.noUploads')}</Empty.Title>
							<Empty.Description>{t('storage.noUploadsHint')}</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each items as item (item.id)}
							<li class="hover:bg-muted/60 flex items-center gap-3 rounded-lg p-2 transition-colors">
								<img
									src={`/api/uploads/${item.id}`}
									alt={item.filename ?? t('storage.uploads')}
									loading="lazy"
									class="size-10 shrink-0 rounded-md border object-cover"
								/>
								<div class="flex min-w-0 flex-1 flex-col">
									<span class="truncate text-sm">{item.filename ?? t('common.unnamed')}</span>
									<span class="text-muted-foreground text-xs">
										{formatBytes(item.bytes)} · {formatDate(item.created_at)}
										{#if !item.message_id}
											· {t('storage.notSent')}
										{/if}
									</span>
								</div>
								<Button
									variant="ghost"
									size="icon"
									class="text-muted-foreground hover:text-destructive shrink-0"
									aria-label={t('common.delete')}
									disabled={deleting === item.id}
									onclick={() => remove(item.id)}
								>
									{#if deleting === item.id}
										<Spinner />
									{:else}
										<Trash2Icon />
									{/if}
								</Button>
							</li>
						{/each}
					</ul>
					<p class="text-muted-foreground text-xs">{t('storage.deletedNote')}</p>
				{/if}
			</section>
		</div>
	</Dialog.Content>
</Dialog.Root>
