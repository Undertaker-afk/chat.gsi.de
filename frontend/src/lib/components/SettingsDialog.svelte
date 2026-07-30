<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
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
	import { formatBytes, formatDate } from '$lib/format';

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
			<Dialog.Title>Einstellungen</Dialog.Title>
			<Dialog.Description>Design und hochgeladene Dateien verwalten.</Dialog.Description>
		</Dialog.Header>

		<Separator />

		<div class="flex flex-col gap-6 overflow-y-auto px-6 py-5">
			<!-- Theme -->
			<section class="flex flex-col gap-3">
				<div class="flex flex-col gap-0.5">
					<h3 class="text-sm font-medium">Design</h3>
					<p class="text-muted-foreground text-xs">
						„System“ folgt der Einstellung Ihres Betriebssystems.
					</p>
				</div>
				<ToggleGroup.Root
					type="single"
					variant="outline"
					value={userPrefersMode.current}
					onValueChange={(v) => v && setMode(v as 'light' | 'dark' | 'system')}
					class="justify-start"
				>
					<ToggleGroup.Item value="light" aria-label="Helles Design">
						<SunIcon data-icon="inline-start" />
						Hell
					</ToggleGroup.Item>
					<ToggleGroup.Item value="dark" aria-label="Dunkles Design">
						<MoonIcon data-icon="inline-start" />
						Dunkel
					</ToggleGroup.Item>
					<ToggleGroup.Item value="system" aria-label="Systemdesign">
						<MonitorIcon data-icon="inline-start" />
						System
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</section>

			<Separator />

			<!-- Storage -->
			<section class="flex flex-col gap-3">
				<div class="flex items-baseline justify-between gap-2">
					<div class="flex flex-col gap-0.5">
						<h3 class="flex items-center gap-1.5 text-sm font-medium">
							<HardDriveIcon class="size-3.5" />
							Speicher
						</h3>
						<p class="text-muted-foreground text-xs">
							{formatBytes(used)} von {formatBytes(quota)} belegt
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
					aria-label="{formatBytes(uploads)} Uploads, {formatBytes(chats)} Chats, {formatBytes(
						generated
					)} generierte Dateien, {formatBytes(free)} frei"
				>
					<div class="bg-orange-500 transition-[width]" style:width={share(uploads)}></div>
					<div class="bg-emerald-500 transition-[width]" style:width={share(chats)}></div>
					<div class="bg-sky-500 transition-[width]" style:width={share(generated)}></div>
				</div>

				<dl class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
					<div class="flex items-center gap-1.5">
						<span class="size-2 rounded-full bg-orange-500"></span>
						<dt class="text-muted-foreground">Uploads</dt>
						<dd class="tabular-nums">{formatBytes(uploads)}</dd>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="size-2 rounded-full bg-emerald-500"></span>
						<dt class="text-muted-foreground">Chats</dt>
						<dd class="tabular-nums">{formatBytes(chats)}</dd>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="size-2 rounded-full bg-sky-500"></span>
						<dt class="text-muted-foreground">Generiert</dt>
						<dd class="tabular-nums">{formatBytes(generated)}</dd>
					</div>
					<div class="flex items-center gap-1.5">
						<span class="bg-muted-foreground/25 size-2 rounded-full"></span>
						<dt class="text-muted-foreground">Frei</dt>
						<dd class="tabular-nums">{formatBytes(free)}</dd>
					</div>
				</dl>

				{#if loading}
					<div class="text-muted-foreground flex items-center gap-2 py-4 text-sm">
						<Spinner class="size-4" />
						Wird geladen…
					</div>
				{:else if items.length === 0}
					<Empty.Root class="py-6">
						<Empty.Header>
							<Empty.Media variant="icon">
								<ImageIcon />
							</Empty.Media>
							<Empty.Title>Keine Uploads</Empty.Title>
							<Empty.Description>
								Angehängte Bilder erscheinen hier und können einzeln gelöscht werden.
							</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each items as item (item.id)}
							<li
								class="hover:bg-muted/60 flex items-center gap-3 rounded-lg p-2 transition-colors"
							>
								<img
									src={`/api/uploads/${item.id}`}
									alt={item.filename ?? 'Upload'}
									loading="lazy"
									class="size-10 shrink-0 rounded-md border object-cover"
								/>
								<div class="flex min-w-0 flex-1 flex-col">
									<span class="truncate text-sm">{item.filename ?? 'Ohne Namen'}</span>
									<span class="text-muted-foreground text-xs">
										{formatBytes(item.bytes)} · {formatDate(item.created_at)}
										{#if !item.message_id}
											· nicht gesendet
										{/if}
									</span>
								</div>
								<Button
									variant="ghost"
									size="icon"
									class="text-muted-foreground hover:text-destructive shrink-0"
									aria-label="Löschen"
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
					<p class="text-muted-foreground text-xs">
						Gelöschte Bilder verschwinden auch aus bereits gesendeten Nachrichten.
					</p>
				{/if}
			</section>
		</div>
	</Dialog.Content>
</Dialog.Root>
