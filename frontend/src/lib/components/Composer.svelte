<script lang="ts">
	import ModePicker from './ModePicker.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import SquareIcon from '@lucide/svelte/icons/square';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { Spinner } from '$lib/components/ui/spinner';
	import { formatBytes } from '$lib/format';
	import { t } from '$lib/language.svelte';

	let {
		mode = $bindable<'fast' | 'deep'>('fast'),
		busy = false,
		knowledgeBases = [],
		onsubmit,
		onstop
	}: {
		mode?: 'fast' | 'deep';
		busy?: boolean;
		/** What this user is allowed to search. Display only -- see plan.md §8b. */
		knowledgeBases?: { id: number; label: string }[];
		/**
		 * `images` are attachment ids from POST /api/uploads; `files` are generated-
		 * file ids, whose text the server reads and puts in front of the question.
		 */
		onsubmit: (text: string, images: string[], files: Generated[]) => void;
		onstop: () => void;
	} = $props();

	interface Upload {
		id: string;
		url: string;
		filename: string | null;
		/**
		 * True when this draft uploaded the file. Re-attaching from the history
		 * submenu points at a file that may already belong to an older message, so
		 * removing it here must not delete it from storage.
		 */
		fresh: boolean;
	}

	/**
	 * A file from Generierte Dateien, attached by reference. Declared alongside
	 * `images` because `expanded` below reads both.
	 */
	interface Generated {
		id: string;
		filename: string;
		mime: string;
		language: string | null;
		bytes: number;
	}

	let draft = $state('');
	let images = $state<Upload[]>([]);
	let attached = $state<Generated[]>([]);
	const MAX_ATTACHED = 3;
	let uploading = $state(0);
	let uploadError = $state<string | null>(null);
	let box = $state<HTMLTextAreaElement | null>(null);
	let picker = $state<HTMLInputElement | null>(null);

	const MAX_HEIGHT = 240;
	const MAX_IMAGES = 4;

	/**
	 * Grok-style reflow: a single-line composer keeps the controls beside the
	 * text; as soon as the text wraps, the textarea takes the full width and the
	 * controls drop to their own row underneath.
	 *
	 * Implemented with flex-wrap + `order` rather than by swapping markup, so the
	 * textarea node is never unmounted and the caret and IME state survive the
	 * transition.
	 */
	let singleLineHeight = $state(0);
	let measured = $state(0);
	const expanded = $derived(
		images.length > 0 ||
			attached.length > 0 ||
			uploading > 0 ||
			(singleLineHeight > 0 && measured > singleLineHeight + 2)
	);

	function grow() {
		if (!box) return;
		box.style.height = 'auto';
		const needed = box.scrollHeight;
		// Capture the natural one-line height once, so the threshold follows the
		// real font metrics instead of a guessed pixel value.
		if (singleLineHeight === 0 && draft === '') singleLineHeight = needed;
		measured = needed;
		box.style.height = `${Math.min(needed, MAX_HEIGHT)}px`;
		box.style.overflowY = needed > MAX_HEIGHT ? 'auto' : 'hidden';
	}

	$effect(() => {
		if (box && singleLineHeight === 0) grow();
	});

	function submit(event?: SubmitEvent) {
		event?.preventDefault();
		const text = draft.trim();
		if (!text || busy) return;
		onsubmit(
			text,
			images.map((i) => i.id),
			// The whole records, so the message can name them before it is saved.
			[...attached]
		);
		draft = '';
		images = [];
		attached = [];
		uploadError = null;
		measured = singleLineHeight;
		queueMicrotask(grow);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	}

	/**
	 * Upload immediately rather than holding base64 in memory: the server owns the
	 * bytes, enforces the per-user quota, and the message only carries a reference.
	 */
	async function addFiles(files: FileList | null) {
		if (!files) return;
		uploadError = null;

		for (const file of Array.from(files)) {
			if (images.length + uploading >= MAX_IMAGES) break;
			if (!file.type.startsWith('image/') && file.type !== 'application/pdf') continue;

			uploading += 1;
			try {
				const form = new FormData();
				form.append('file', file);
				const res = await fetch('/api/uploads', { method: 'POST', body: form });
				if (!res.ok) {
					const detail = await res.json().catch(() => null);
					uploadError = detail?.message ?? t('composer.uploadFailedStatus', { status: String(res.status) });
					continue;
				}
				const saved = await res.json();
				images.push({ id: saved.id, url: saved.url, filename: saved.filename, fresh: true });
				recentLoaded = false; // history is stale now; refetch when next opened
			} catch {
				uploadError = t('composer.uploadFailed');
			} finally {
				uploading -= 1;
			}
		}
		queueMicrotask(grow);
	}

	async function discard(index: number) {
		const [removed] = images.splice(index, 1);
		// Uploaded for this draft and never sent, so it is pure quota waste -- drop
		// it server-side too. Re-attached files belong to an older message; leave
		// them alone.
		if (removed?.fresh) {
			await fetch(`/api/uploads/${removed.id}`, { method: 'DELETE' });
			recentLoaded = false;
		}
		queueMicrotask(grow);
	}

	/**
	 * Recently uploaded files, for the "Verlauf" submenu. Attaching one costs no
	 * new storage: the message just references the id that is already there.
	 */
	interface Recent {
		id: string;
		url: string;
		filename: string | null;
		bytes: number;
	}
	let recent = $state<Recent[]>([]);
	let recentLoaded = $state(false);

	async function loadRecent() {
		try {
			const res = await fetch('/api/uploads?limit=10');
			if (!res.ok) return;
			const data = await res.json();
			recent = (data.items ?? []).map((i: Recent) => ({ ...i, url: `/api/uploads/${i.id}` }));
		} finally {
			recentLoaded = true;
		}
	}

	function reattach(item: Recent) {
		if (images.length + uploading >= MAX_IMAGES) return;
		if (images.some((i) => i.id === item.id)) return;
		images.push({ id: item.id, url: item.url, filename: item.filename, fresh: false });
		queueMicrotask(grow);
	}

	/**
	 * Generated files, for the "Generiert" submenu.
	 *
	 * Attaching one costs no storage and uploads nothing: the message carries the
	 * id and the server reads the text it already holds. Kept separate from
	 * `images` because these are text, not something with a thumbnail.
	 */
	let generated = $state<Generated[]>([]);
	let generatedLoaded = $state(false);

	async function loadGenerated() {
		try {
			const res = await fetch('/api/files');
			if (!res.ok) return;
			const data = await res.json();
			// The endpoint returns every file, newest first; the menu shows the ten
			// most recent, which is what a composer drop-up has room for.
			generated = (data.items ?? []).slice(0, 10);
		} finally {
			generatedLoaded = true;
		}
	}

	function attach(item: Generated) {
		if (attached.length >= MAX_ATTACHED) return;
		if (attached.some((f) => f.id === item.id)) return;
		attached.push(item);
		queueMicrotask(grow);
	}

	function detach(index: number) {
		attached.splice(index, 1);
		queueMicrotask(grow);
	}

	/** Pasting a screenshot straight into the box is the common case. */
	function onpaste(event: ClipboardEvent) {
		const files = event.clipboardData?.files;
		if (files?.length) {
			event.preventDefault();
			addFiles(files);
		}
	}
</script>

<form onsubmit={submit} class="mx-auto w-full max-w-3xl px-4 pb-4">
	<div class="bg-card focus-within:border-ring/60 rounded-3xl border shadow-sm transition-colors">
		{#if images.length > 0 || uploading > 0 || uploadError}
			<div class="flex flex-wrap items-center gap-2 px-3 pt-3">
				{#each images as image, i (image.id)}
					<div class="group relative">
						<img
							src={image.url}
							alt={image.filename ?? t('composer.attachment', { n: i + 1 })}
							class="size-16 rounded-lg border object-cover"
						/>
						<button
							type="button"
							aria-label={t('composer.removeAttachment')}
							class="bg-background/90 absolute -top-1.5 -right-1.5 rounded-full border p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
							onclick={() => discard(i)}
						>
							<XIcon class="size-3" />
						</button>
					</div>
				{/each}

				{#each Array(uploading) as _, i (i)}
					<div class="bg-muted flex size-16 items-center justify-center rounded-lg border">
						<Spinner class="size-4" />
					</div>
				{/each}

				{#if uploadError}
					<p class="text-destructive text-xs">{uploadError}</p>
				{/if}
			</div>
		{/if}

		{#if attached.length > 0}
			<!-- Text files get a named chip rather than a thumbnail: the filename is
			     the only thing that identifies them. -->
			<div class="flex flex-wrap items-center gap-2 px-3 pt-3">
				{#each attached as file, i (file.id)}
					<span
						class="bg-muted flex max-w-[16rem] items-center gap-1.5 rounded-full border py-1 pr-1 pl-2.5 text-xs"
					>
						<FileTextIcon class="text-muted-foreground size-3.5 shrink-0" />
						<span class="truncate font-mono">{file.filename}</span>
						<span class="text-muted-foreground shrink-0 tabular-nums">
							{formatBytes(file.bytes)}
						</span>
						<button
							type="button"
							aria-label={t('composer.removeFile')}
							class="hover:bg-background rounded-full p-0.5"
							onclick={() => detach(i)}
						>
							<XIcon class="size-3" />
						</button>
					</span>
				{/each}
			</div>
		{/if}

		<div class="flex flex-wrap items-end gap-1 p-2">
			<!-- Attach: order-2 on one line, first in the control row when wrapped -->
			<!--
				Uploads are cached after the first fetch, but the generated list is
				re-read every time: a file saved from a code block a moment ago has to
				appear here, and this component never hears about that.
			-->
			<DropdownMenu.Root
				onOpenChange={(open) => {
					if (!open) return;
					if (!recentLoaded) loadRecent();
					loadGenerated();
				}}
			>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							type="button"
							variant="ghost"
							size="icon"
							class="text-muted-foreground order-2 shrink-0 rounded-full"
							aria-label={t('composer.attach')}
							disabled={busy}
						>
							<PlusIcon />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<!-- Opens upwards: the composer sits at the bottom of the window. -->
				<DropdownMenu.Content side="top" align="start" class="w-52">
					<DropdownMenu.Group>
						<DropdownMenu.Item
							onSelect={() => picker?.click()}
							disabled={images.length + uploading >= MAX_IMAGES}
						>
							<UploadIcon />
							{t('composer.upload')}
						</DropdownMenu.Item>

						<DropdownMenu.Sub>
							<DropdownMenu.SubTrigger disabled={images.length + uploading >= MAX_IMAGES}>
								<HistoryIcon />
								{t('composer.history')}
							</DropdownMenu.SubTrigger>
							<!-- side="right": the submenu unfolds beside the drop-up, not over it. -->
							<DropdownMenu.SubContent side="right" sideOffset={4} class="w-64">
								{#if !recentLoaded}
									<div class="text-muted-foreground flex items-center gap-2 px-2 py-3 text-sm">
										<Spinner class="size-4" />
										{t('common.loading')}
									</div>
								{:else if recent.length === 0}
									<p class="text-muted-foreground px-2 py-3 text-sm">{t('composer.noRecentUploads')}</p>
								{:else}
									<DropdownMenu.Group>
										{#each recent as item (item.id)}
											<DropdownMenu.Item
												onSelect={() => reattach(item)}
												disabled={images.some((i) => i.id === item.id)}
											>
												<img
													src={item.url}
													alt=""
													loading="lazy"
													class="size-6 shrink-0 rounded border object-cover"
												/>
												<span class="truncate">{item.filename ?? t('common.unnamed')}</span>
												<span class="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
													{formatBytes(item.bytes)}
												</span>
											</DropdownMenu.Item>
										{/each}
									</DropdownMenu.Group>
								{/if}
							</DropdownMenu.SubContent>
						</DropdownMenu.Sub>

						<DropdownMenu.Sub>
							<DropdownMenu.SubTrigger>
								<FileTextIcon />
								{t('composer.generated')}
							</DropdownMenu.SubTrigger>
							<DropdownMenu.SubContent side="right" sideOffset={4} class="w-72">
								{#if !generatedLoaded}
									<div class="text-muted-foreground flex items-center gap-2 px-2 py-3 text-sm">
										<Spinner class="size-4" />
										{t('common.loading')}
									</div>
								{:else if generated.length === 0}
									<p class="text-muted-foreground px-2 py-3 text-sm">
										{t('composer.noGenerated')}
									</p>
								{:else}
									<DropdownMenu.Group>
										{#each generated as item (item.id)}
											<DropdownMenu.Item
												onSelect={() => attach(item)}
												disabled={attached.some((f) => f.id === item.id) ||
													attached.length >= MAX_ATTACHED}
											>
												<FileTextIcon class="shrink-0" />
												<span class="truncate font-mono text-xs">{item.filename}</span>
												<span class="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
													{formatBytes(item.bytes)}
												</span>
											</DropdownMenu.Item>
										{/each}
									</DropdownMenu.Group>
								{/if}
							</DropdownMenu.SubContent>
						</DropdownMenu.Sub>
					</DropdownMenu.Group>
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			<input
				bind:this={picker}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pptx,.docx,.xlsx,.odp,.odt,.ods"
				multiple
				class="hidden"
				onchange={(e) => {
					addFiles(e.currentTarget.files);
					e.currentTarget.value = '';
				}}
			/>

			<textarea
				bind:this={box}
				bind:value={draft}
				oninput={grow}
				{onkeydown}
				{onpaste}
				rows="1"
				placeholder={t('composer.placeholder')}
				class="placeholder:text-muted-foreground min-h-0 resize-none border-0 bg-transparent px-2 py-2 text-[0.95rem] leading-6 outline-none
					{expanded ? 'order-1 w-full basis-full' : 'order-3 flex-1'}"
			></textarea>

			<div class="order-4 ml-auto flex shrink-0 items-center gap-1">
				<ModePicker bind:value={mode} disabled={busy} />

				{#if busy}
					<Button
						type="button"
						size="icon"
						variant="secondary"
						aria-label={t('common.cancel')}
						onclick={onstop}
					>
						<SquareIcon />
					</Button>
				{:else}
					<Button
						type="submit"
						size="icon"
						aria-label={t('composer.send')}
						disabled={!draft.trim()}
					>
						<ArrowUpIcon />
					</Button>
				{/if}
			</div>
		</div>
	</div>

	<p class="text-muted-foreground mt-2 text-center text-xs">
		{mode === 'deep' ? t('composer.deepNote') : t('composer.fastNote')}
		· {t('composer.enterHint')}
	</p>

	<!--
		Which knowledge bases the question will reach. Not a control: access is
		decided by the group, and narrowing it here would only produce worse
		answers. It exists so an unanswerable question has a visible reason.
	-->
	<p class="text-muted-foreground mt-1 text-center text-xs">
		{#if knowledgeBases.length}
			{t('composer.searches', { list: knowledgeBases.map((kb) => kb.label).join(', ') })}
		{:else}
			<span class="text-destructive">{t('composer.noKnowledgeBase')}</span>
		{/if}
	</p>
</form>
