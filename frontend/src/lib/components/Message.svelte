<script lang="ts">
	import type { ChatMessage, AttachedFile } from '$lib/chat.svelte';
	import { formatBytes } from '$lib/format';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import SvelteMarkdown, { buildUnsupportedHTML } from '@humanspeak/svelte-markdown';
	import type {
		LinkSnippetProps,
		CodeSnippetProps,
		ImageSnippetProps
	} from '@humanspeak/svelte-markdown';
	import { withCitationLinks, citationMarker, usedCitations } from '$lib/markdown';
	import { viewer, isPdfLink } from '$lib/viewer.svelte';
	import { copyText } from '$lib/clipboard';
	import ShikiCode from './ShikiCode.svelte';
	import EditCard from './EditCard.svelte';
	import { isEditFence, parseEdit } from '$lib/edits';
	import AgentTrace from './AgentTrace.svelte';
	import DocumentTrace from './DocumentTrace.svelte';
	import MediathekTrace from './MediathekTrace.svelte';
	import * as Alert from '$lib/components/ui/alert';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Dialog from '$lib/components/ui/dialog';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ThumbsUpIcon from '@lucide/svelte/icons/thumbs-up';
	import ThumbsDownIcon from '@lucide/svelte/icons/thumbs-down';
	import SaveIcon from '@lucide/svelte/icons/save';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronLeftSquareIcon from '@lucide/svelte/icons/panel-right-open';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';
	import FileIcon from '@lucide/svelte/icons/file';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { t } from '$lib/language.svelte';

	let {
		message,
		conversationId = null,
		onedit,
		onversion,
		onask,
		latest = false,
		busy = false
	}: {
		message: ChatMessage;
		/** Scope for edit blocks: a file may only be changed from its own chat. */
		conversationId?: string | null;
		onedit?: (message: ChatMessage, text: string) => void;
		onversion?: (messageId: string) => void;
		/** Asks a follow-up. Undefined hides the suggestion strip entirely. */
		onask?: (text: string) => void;
		/**
		 * Last message in the transcript. Follow-ups belong only under the newest
		 * answer -- on an older turn they are stale, and a column of them running up
		 * the transcript is noise.
		 */
		latest?: boolean;
		busy?: boolean;
	} = $props();

	const answerSource = $derived(withCitationLinks(message.content, message.citations));
	const sources = $derived(usedCitations(message.content, message.citations));
	const citationsByMarker = $derived(new Map(message.citations.map((c) => [c.marker, c])));

	// Every HTML tag renders as escaped text rather than as markup. This is the
	// injection guard -- see the note in $lib/markdown.
	const htmlRenderers = buildUnsupportedHTML();

	// gfm + breaks match what marked was configured with before, so tables and
	// single-newline line breaks keep behaving the same way.
	const markdownOptions = { gfm: true, breaks: true };

	let rating = $state<-1 | 1 | null>(null);

	// --- saving a code block to Generierte Dateien ----------------------------

	let saving = $state<string | null>(null);
	let saved = $state<Set<string>>(new Set());
	let saveError = $state<string | null>(null);
	let renaming = $state<{ text: string; lang: string; name: string } | null>(null);

	/** Extension guessed from the fence language, mirroring server-side BY_LANGUAGE. */
	const EXTENSIONS: Record<string, string> = {
		bash: 'sh', sh: 'sh', shell: 'sh', console: 'sh', slurm: 'sh',
		python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
		json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', sql: 'sql',
		c: 'c', cpp: 'cpp', rust: 'rs', go: 'go', java: 'java', xml: 'xml',
		html: 'html', css: 'css', dockerfile: 'dockerfile', markdown: 'md', md: 'md'
	};

	/**
	 * A fence info string is `language [filename]`, e.g. ```bash submit.sh.
	 * The model is asked to supply the name (see ANSWER_SYSTEM); when it does
	 * not, one is derived from the language.
	 */
	function parseFence(info: string, fallbackIndex = 0) {
		const [langId = '', ...rest] = (info || '').trim().split(/\s+/);
		const given = rest.join(' ').trim();
		return { language: langId, filename: given || suggestName(langId, fallbackIndex) };
	}

	/**
	 * The filename exactly as written, with no fallback. An edit block must name a
	 * file that already exists, so an invented `snippet-1.sh` would be worse than
	 * nothing -- it would send the edit at a file the user never saved.
	 */
	function rawFilename(info: string): string {
		const [, ...rest] = (info || '').trim().split(/\s+/);
		return rest.join(' ').trim();
	}

	let copied = $state(false);
	let copyFailed = $state(false);

	/** The raw Markdown the model produced, before any of our rendering. */
	async function copyRaw() {
		const ok = await copyText(message.content);
		copied = ok;
		copyFailed = !ok;
		// A failure has to be visible. The old version swallowed it, so on http://
		// the button looked like it had simply been ignored.
		setTimeout(() => {
			copied = false;
			copyFailed = false;
		}, 1800);
	}

	function suggestName(lang: string, index = 0): string {
		const ext = EXTENSIONS[(lang || '').toLowerCase()] ?? 'txt';
		const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
		return `snippet-${stamp}${index ? `-${index + 1}` : ''}.${ext}`;
	}

	async function saveBlock(text: string, lang: string, filename: string) {
		saving = text;
		saveError = null;
		try {
			const res = await fetch('/api/files', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ filename, content: text, language: lang, messageId: message.id })
			});
			if (res.ok) {
				// Keyed by content: the same block saved twice should stay marked, and
				// two identical blocks in one answer are the same file anyway.
				saved = new Set([...saved, text]);
				renaming = null;
			} else {
				const body = await res.json().catch(() => null);
				saveError = body?.message ?? `Speichern fehlgeschlagen (HTTP ${res.status})`;
			}
		} catch (e) {
			saveError = `Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			saving = null;
		}
	}

	// --- editing / versions --------------------------------------------------

	let editing = $state(false);
	let draft = $state('');
	let editor = $state<HTMLTextAreaElement | null>(null);

	const versions = $derived(message.versions ?? 1);
	const version = $derived(message.version ?? 1);
	const siblings = $derived(message.siblingIds ?? []);
	const canEdit = $derived(Boolean(message.id) && !busy);

	function startEdit() {
		draft = message.content;
		editing = true;
		queueMicrotask(() => {
			editor?.focus();
			editor?.setSelectionRange(draft.length, draft.length);
			grow();
		});
	}

	function grow() {
		if (!editor) return;
		editor.style.height = 'auto';
		editor.style.height = `${Math.min(editor.scrollHeight, 320)}px`;
	}

	function saveEdit() {
		const text = draft.trim();
		editing = false;
		if (text && text !== message.content) onedit?.(message, text);
	}

	/** Lightbox: index of the attachment being viewed, or null. */
	let viewing = $state<number | null>(null);
	const attachments = $derived(message.images ?? []);

	// --- attached generated files ---------------------------------------------

	const attachedFiles = $derived(message.files ?? []);
	let openingFile = $state<string | null>(null);
	let fileError = $state<string | null>(null);

	/**
	 * Show an attached file in the side panel.
	 *
	 * The panel rather than a lightbox: an image only has to be made bigger, but
	 * a script has to be readable -- syntax highlighting, scrolling, and for
	 * Markdown the rendered/source switch. FileViewer already does all of that,
	 * and it is where every other file in the app opens, so this adds no third
	 * way of looking at one.
	 */
	async function openAttached(file: AttachedFile) {
		openingFile = file.id;
		fileError = null;
		try {
			const res = await fetch(`/api/files/${file.id}`);
			if (!res.ok) {
				// 404 is the interesting one: the file was deleted from /files after
				// being sent, so the chip outlived the bytes.
				fileError =
					res.status === 404
						? t('message.fileDeleted', { name: file.filename })
						: t('message.fileLoadError', { status: String(res.status) });
				return;
			}
			const body = await res.json();
			viewer.open({
				kind: 'text',
				filename: file.filename,
				mime: file.mime,
				language: file.language,
				content: body.content
			});
		} catch (e) {
			fileError = `Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			openingFile = null;
		}
	}

	function step(delta: number) {
		const target = siblings[version - 1 + delta];
		if (target) onversion?.(target);
	}

	const PHASES: Record<string, string> = {
		planning: 'Frage wird zerlegt',
		retrieving: 'Dokumentation wird durchsucht',
		reading: 'Ergebnisse werden ausgewertet',
		writing: 'Antwort wird formuliert'
	};

	/** Where a non-corpus source came from, for the chip in the source list. */
	const EXTERNAL_LABEL: Record<string, string> = {
		indico: 'Indico',
		repository: 'Repository',
		'corpus-link': 'Verlinkt'
	};
</script>

<!--
	Link renderer. A `#gsi-cite-n` href is a citation marker rewritten by
	withCitationLinks() and becomes a chip pointing at the real source; anything
	else is an ordinary link the model wrote. Declared at the top level of this
	component so it stays a local snippet rather than becoming a prop of whatever
	element it sits inside.
-->
{#snippet link({ href, title, text, children }: LinkSnippetProps)}
	{@const marker = citationMarker(href)}
	{#if marker !== null}
		{@const source = citationsByMarker.get(marker)}
		<a
			href={source?.url}
			target="_blank"
			rel="noopener noreferrer"
			title={source ? (source.heading ? `${source.title} › ${source.heading}` : source.title) : ''}
			class="citation-chip">{marker}</a
		>
	{:else if isPdfLink(href)}
		<!--
			PDFs open in the side panel instead of a new tab. The panel loads them
			through /api/pdf because www.gsi.de sends no CORS headers, so pdf.js
			cannot fetch them cross-origin.
		-->
		<button
			type="button"
			class="citation-pdf"
			onclick={() => href && viewer.openPdf(href, text || undefined)}
		>
			<FileIcon class="size-3.5 shrink-0" />
			{#if children}{@render children()}{:else}{text}{/if}
		</button>
	{:else}
		<a {href} {title} target="_blank" rel="noopener noreferrer">
			{#if children}{@render children()}{:else}{text}{/if}
		</a>
	{/if}
{/snippet}

<!--
	Image renderer.

	Only `/api/media/<id>` is rendered as an image. Everything else becomes a
	plain link: the model is told exactly one image URL, so any other `![](...)`
	is either invented or points off-site, and an <img> whose src the model chose
	is a request to an arbitrary host made from the user's browser.
-->
{#snippet image({ href, title, text }: ImageSnippetProps)}
	{#if href && /^\/api\/media\/\d+$/.test(href)}
		<figure class="my-3">
			<img
				src={href}
				alt={text || title || 'Bild aus der GSI-Mediathek'}
				loading="lazy"
				class="max-h-[24rem] w-full rounded-lg border object-contain"
			/>
			{#if text}
				<figcaption class="text-muted-foreground mt-1.5 text-xs">{text}</figcaption>
			{/if}
		</figure>
	{:else}
		<a href={href} target="_blank" rel="noopener noreferrer">{text || href}</a>
	{/if}
{/snippet}

<!--
	Code renderer. Same <pre><code> the default produces, plus the controls that
	put the block into Generierte Dateien. Streaming blocks get no button: the
	fence is still growing, so saving one would store a truncated file.
-->
{#snippet code({ lang, text }: CodeSnippetProps)}
	{@const fence = parseFence(lang)}
	{@const edit = isEditFence(fence.language) ? parseEdit(rawFilename(lang), text) : null}
	{#if edit}
		<!-- A search/replace on a file from this conversation, not a code sample. -->
		<EditCard {edit} {conversationId} />
	{:else}
	<div class="bg-muted/40 overflow-hidden rounded-xl border">
		<!-- Header: filename left, actions right, as in the sketch. -->
		<div class="bg-muted/70 flex items-center gap-2 border-b px-3 py-1.5">
			<span class="truncate font-mono text-xs">{fence.filename}</span>
			{#if fence.language}
				<Badge variant="secondary" class="shrink-0 text-[0.65rem]">{fence.language}</Badge>
			{/if}
			<div class="ml-auto flex shrink-0 items-center gap-1">
				{#if !message.streaming}
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						aria-label="In Dateien speichern"
						disabled={saving === text}
						onclick={() => (renaming = { text, lang: fence.language, name: fence.filename })}
					>
						{#if saving === text}
							<Spinner class="size-3" />
						{:else if saved.has(text)}
							<CheckIcon class="size-3" />
						{:else}
							<SaveIcon class="size-3" />
						{/if}
					</Button>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						aria-label={t('message.openInPanel')}
						onclick={() =>
							viewer.open({
								kind: 'text',
								filename: fence.filename,
								mime: fence.filename.toLowerCase().endsWith('.md')
									? 'text/markdown'
									: 'text/plain',
								language: fence.language || 'plaintext',
								content: text
							})}
					>
						<ChevronLeftSquareIcon class="size-3.5" />
					</Button>
				{/if}
			</div>
		</div>
		<!--
			Truncated preview. The full text lives one click away in the panel, so a
			200-line script does not push the rest of the answer off screen.
		-->
		<div class="max-h-56 overflow-auto">
			<ShikiCode code={text} lang={fence.language} streaming={message.streaming ?? false} />
		</div>
	</div>
	{/if}
{/snippet}

<!-- Naming step before a block is stored. A generated file is something the
     user will look for later, so it gets a real name rather than an id. -->
<Dialog.Root open={renaming !== null} onOpenChange={(o) => !o && (renaming = null)}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{t('message.saveToGenerated')}</Dialog.Title>
			<Dialog.Description>
				{t('message.overwriteWarning')}
			</Dialog.Description>
		</Dialog.Header>
		{#if renaming}
			<div class="flex flex-col gap-2">
				<Label for="generated-name">{t('message.filenameLabel')}</Label>
				<Input
					id="generated-name"
					bind:value={renaming.name}
					onkeydown={(e) => {
						if (e.key === 'Enter' && renaming?.name.trim()) {
							saveBlock(renaming.text, renaming.lang, renaming.name.trim());
						}
					}}
				/>
				<p class="text-muted-foreground text-xs">
					{t('message.filenameHint')}
				</p>
			</div>
		{/if}
		{#if saveError}
			<Alert.Root variant="destructive">
				<TriangleAlertIcon />
				<Alert.Description>{saveError}</Alert.Description>
			</Alert.Root>
		{/if}
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (renaming = null)}>{t('common.cancel')}</Button>
			<Button
				disabled={!renaming?.name.trim() || saving !== null}
				onclick={() =>
					renaming && saveBlock(renaming.text, renaming.lang, renaming.name.trim())}
			>
				{#if saving !== null}<Spinner data-icon="inline-start" />{/if}
				{t('common.save')}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if message.role === 'user'}
	<div class="group flex flex-col items-end gap-1">
		{#if editing}
			<div class="w-full max-w-[85%]">
				<Textarea
					bind:ref={editor}
					bind:value={draft}
					oninput={grow}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							saveEdit();
						}
						if (e.key === 'Escape') editing = false;
					}}
					class="max-h-[320px] min-h-0 resize-none"
				/>
				<div class="mt-2 flex justify-end gap-2">
					<Button variant="ghost" size="sm" onclick={() => (editing = false)}>Abbrechen</Button>
					<Button size="sm" onclick={saveEdit} disabled={!draft.trim()}>Senden</Button>
				</div>
			</div>
		{:else}
			{#if attachments.length}
				<div class="flex max-w-[85%] flex-wrap justify-end gap-2">
					{#each attachments as src, i (src)}
						<button
							type="button"
							class="focus-visible:ring-ring rounded-xl focus-visible:ring-2 focus-visible:outline-none"
							aria-label={t('message.enlargeAttachment', { n: i + 1 })}
							onclick={() => (viewing = i)}
						>
							<img
								{src}
								alt={t('message.attachment', { n: i + 1 })}
								loading="lazy"
								class="size-20 rounded-xl border object-cover transition-opacity hover:opacity-85"
							/>
						</button>
					{/each}
				</div>
			{/if}
			{#if attachedFiles.length}
				<!--
					Generated files carried by this question. A chip rather than a
					thumbnail: these are text, and the filename is the only thing that
					identifies them. Clicking opens the same panel the code blocks use.
				-->
				<div class="flex max-w-[85%] flex-wrap justify-end gap-2">
					{#each attachedFiles as file (file.id)}
						<button
							type="button"
							class="bg-muted hover:bg-muted/70 flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60"
							disabled={openingFile === file.id}
							title="{file.filename} · {formatBytes(file.bytes)}"
							onclick={() => openAttached(file)}
						>
							{#if openingFile === file.id}
								<Spinner class="size-3.5 shrink-0" />
							{:else}
								<FileTextIcon class="text-muted-foreground size-3.5 shrink-0" />
							{/if}
							<span class="truncate font-mono">{file.filename}</span>
							<span class="text-muted-foreground shrink-0 tabular-nums">
								{formatBytes(file.bytes)}
							</span>
						</button>
					{/each}
				</div>
				{#if fileError}
					<p class="text-destructive max-w-[85%] text-xs">{fileError}</p>
				{/if}
			{/if}

			<div class="bg-primary text-primary-foreground max-w-[85%] rounded-2xl px-4 py-2.5">
				<p class="whitespace-pre-wrap">{message.content}</p>
			</div>

			<!-- Version pager + edit. Hidden until hover so it does not clutter the
			     transcript, but the pager stays visible whenever alternatives exist. -->
			<div class="flex items-center gap-0.5">
				{#if versions > 1}
					<div class="text-muted-foreground flex items-center gap-0.5 text-xs">
						<Button
							variant="ghost"
							size="icon"
							class="size-6"
							aria-label={t('message.previousVersion')}
							disabled={version <= 1 || busy}
							onclick={() => step(-1)}
						>
							<ChevronLeftIcon />
						</Button>
						<span class="tabular-nums">{version} / {versions}</span>
						<Button
							variant="ghost"
							size="icon"
							class="size-6"
							aria-label={t('message.nextVersion')}
							disabled={version >= versions || busy}
							onclick={() => step(1)}
						>
							<ChevronRightIcon />
						</Button>
					</div>
				{/if}

				{#if canEdit}
					<Button
						variant="ghost"
						size="icon"
						class="text-muted-foreground size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
						aria-label={t('message.editMessage')}
						onclick={startEdit}
					>
						<PencilIcon />
					</Button>
				{/if}
			</div>
		{/if}
	</div>

	<Dialog.Root
		open={viewing !== null}
		onOpenChange={(open) => {
			if (!open) viewing = null;
		}}
	>
		<Dialog.Content class="max-w-[92vw] sm:max-w-3xl">
			<Dialog.Header>
				<Dialog.Title class="sr-only">
					{t('message.attachmentOf', { n: (viewing ?? 0) + 1, total: attachments.length })}
				</Dialog.Title>
			</Dialog.Header>

			{#if viewing !== null}
				<img
					src={attachments[viewing]}
					alt={t('message.attachment', { n: viewing + 1 })}
					class="max-h-[75vh] w-full rounded-lg object-contain"
				/>

				{#if attachments.length > 1}
					<div class="text-muted-foreground flex items-center justify-center gap-2 text-sm">
						<Button
							variant="ghost"
							size="icon"
							aria-label={t('message.previousAttachment')}
							disabled={viewing === 0}
							onclick={() => viewing !== null && (viewing -= 1)}
						>
							<ChevronLeftIcon />
						</Button>
						<span class="tabular-nums">{viewing + 1} / {attachments.length}</span>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t('message.nextAttachment')}
							disabled={viewing === attachments.length - 1}
							onclick={() => viewing !== null && (viewing += 1)}
						>
							<ChevronRightIcon />
						</Button>
					</div>
				{/if}
			{/if}
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<div class="flex gap-3">
		<div
			class="bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
		>
			{#if message.streaming}
				<Spinner />
			{:else}
				<SparklesIcon class="size-4" />
			{/if}
		</div>

		<div class="flex min-w-0 flex-1 flex-col gap-3">
			{#if message.agents.length > 0}
				<AgentTrace agents={message.agents} running={message.streaming ?? false} />
			{/if}

			<!-- One row per agent, each its own dropdown. Both sit outside the
			     AgentTrace check: the documents agent runs on every turn, and the
			     image agent belongs beside it rather than inside a block counting
			     research subagents it is not one of. -->
			{#if message.image}
				<MediathekTrace image={message.image} />
			{/if}

			<!-- Outside the agents check: the documents agent runs on every turn,
			     including fast ones where there is no AgentTrace at all. -->
			{#if message.documents}
				<DocumentTrace documents={message.documents} />
			{/if}

			{#if message.phase && !message.content}
				<p class="text-muted-foreground flex items-center gap-2 text-sm">
					<span class="bg-primary size-1.5 animate-pulse rounded-full"></span>
					{PHASES[message.phase] ?? message.phase}
					{#if message.round && message.round > 1}
						· Runde {message.round}
					{/if}
				</p>
			{/if}

			{#if message.content}
				<!-- Safe: html renderers are all UnsupportedHTML, which prints tags as
				     escaped text instead of rendering them. No {@html} anywhere. -->
				<div class="answer-prose text-foreground min-w-0 text-[0.95rem] leading-relaxed">
					<SvelteMarkdown
						source={answerSource}
						options={markdownOptions}
						renderers={{ html: htmlRenderers }}
						{link}
						{code}
						{image}
					/>{#if message.streaming}<span
							class="bg-foreground/70 ml-0.5 inline-block h-[1em] w-[2px] animate-pulse align-text-bottom"
						></span>{/if}
				</div>
			{/if}

			{#if message.partial}
				<Alert.Root variant="destructive">
					<ClockIcon />
					<Alert.Title>{t('message.incompleteAnswer')}</Alert.Title>
					<Alert.Description>
						{t('message.timeoutDescription')}
					</Alert.Description>
				</Alert.Root>
			{/if}

			{#if message.error}
				<Alert.Root variant="destructive">
					<TriangleAlertIcon />
					<Alert.Title>{t('message.error')}</Alert.Title>
					<Alert.Description>{message.error}</Alert.Description>
				</Alert.Root>
			{/if}

			{#if sources.length > 0 && !message.streaming}
				<Collapsible.Root>
					<div class="flex items-center gap-1">
						<Collapsible.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="ghost" size="sm" class="text-muted-foreground -ml-2">
									<ChevronDownIcon data-icon="inline-start" />
									{sources.length}
									{sources.length === 1 ? t('message.source') : t('message.sources')}
								</Button>
							{/snippet}
						</Collapsible.Trigger>

						<div class="ml-auto flex items-center gap-0.5">
							<Button
								variant="ghost"
								size="icon"
								aria-label="Hilfreich"
								class={rating === 1 ? 'text-primary' : 'text-muted-foreground'}
								onclick={() => (rating = rating === 1 ? null : 1)}
							>
								<ThumbsUpIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Nicht hilfreich"
								class={rating === -1 ? 'text-destructive' : 'text-muted-foreground'}
								onclick={() => (rating = rating === -1 ? null : -1)}
							>
								<ThumbsDownIcon />
							</Button>
							<!-- The raw Markdown, not the rendered text: what the model actually
							     wrote, so it can be pasted somewhere that renders it again. -->
							<Button
								variant="ghost"
								size="icon"
								class={copyFailed ? 'text-destructive' : 'text-muted-foreground'}
								aria-label="Antwort als Markdown kopieren"
								title={copyFailed ? 'Kopieren wurde vom Browser blockiert' : undefined}
								onclick={copyRaw}
							>
								{#if copied}<CheckIcon />{:else if copyFailed}<TriangleAlertIcon />{:else}<CopyIcon
									/>{/if}
							</Button>
						</div>
					</div>

					<Collapsible.Content>
						<ul class="mt-1 flex flex-col gap-1">
							{#each sources as source (source.marker)}
								<li>
									<a
										href={source.url}
										target="_blank"
										rel="noopener noreferrer"
										class="hover:bg-muted/60 group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors"
									>
										<Badge variant="secondary" class="mt-0.5 font-mono">{source.marker}</Badge>
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm font-medium">{source.title}</span>
											<span
												class="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs"
											>
												{#if source.external}
													<!-- Not from the crawled documentation. A talk is one
													     person's account on one day, and a reader weighing
													     an answer needs to know which kind of source they
													     are looking at. -->
													<Badge variant="outline" class="px-1 py-0 text-[10px] font-normal">
														{EXTERNAL_LABEL[source.external.origin]}
													</Badge>
													{#if !source.external.read}
														<span class="text-amber-600 dark:text-amber-500">nur Metadaten</span>
													{/if}
												{/if}
												{#if source.heading}
													<span class="min-w-0 truncate">{source.heading}</span>
												{/if}
											</span>
										</span>
										<ExternalLinkIcon
											class="text-muted-foreground mt-1 size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
										/>
									</a>
								</li>
							{/each}
						</ul>
					</Collapsible.Content>
				</Collapsible.Root>
			{/if}

			{#if latest && !message.streaming && onask && message.suggestions?.length}
				<!-- Follow-ups. Separated by a rule rather than boxed: they are an
				     invitation to continue, not part of the answer. -->
				<div class="mt-1 flex flex-col border-t pt-1">
					{#each message.suggestions as suggestion (suggestion)}
						<button
							type="button"
							class="hover:bg-muted/60 -mx-2 flex items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors disabled:opacity-50"
							disabled={busy}
							onclick={() => onask?.(suggestion)}
						>
							<CornerDownRightIcon class="text-muted-foreground size-3.5 shrink-0" />
							<span class="min-w-0 flex-1">{suggestion}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
