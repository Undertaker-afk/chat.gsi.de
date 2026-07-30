<script lang="ts">
	import { onMount } from 'svelte';
	import { ChatSession, type ChatMessage } from '$lib/chat.svelte';
	import Message from '$lib/components/Message.svelte';
	import ModeToggle from '$lib/components/ModeToggle.svelte';
	import ChatSidebar from '$lib/components/ChatSidebar.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import FileViewer from '$lib/components/FileViewer.svelte';
	import { viewer } from '$lib/viewer.svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import SettingsDialog from '$lib/components/SettingsDialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Empty from '$lib/components/ui/empty';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import FilesIcon from '@lucide/svelte/icons/files';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import UsersIcon from '@lucide/svelte/icons/users';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';

	let { data } = $props();

	const chat = new ChatSession();
	let pane = $state<HTMLElement | null>(null);
	let settingsOpen = $state(false);

	onMount(() => chat.loadConversations());

	const SUGGESTIONS = [
		'Wie setze ich mein GSI Linux-Passwort zurück?',
		'Welche Linux-Dienste bietet GSI an?',
		'Wie beantrage ich einen Linux-Account?',
		'Was ist das Lustre-Dateisystem?'
	];

	// Role-gated entries. The pages enforce the role themselves (hooks.server.ts
	// and each load); this only decides what is worth showing.
	const roles = $derived<string[]>(data.user?.roles ?? []);
	const canAdminister = $derived(roles.includes('llmbot-admin'));
	const canManage = $derived(roles.includes('llmbot-privileged'));

	const initials = $derived(
		(data.user?.name ?? '?')
			.split(/\s+/)
			.map((p: string) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

	const currentTitle = $derived(
		chat.conversations.find((c) => c.id === chat.conversationId)?.title ?? null
	);

	// Follow the stream, but only while the user is already near the bottom --
	// yanking the viewport during a long deep-mode answer is worse than not
	// scrolling at all.
	$effect(() => {
		void chat.messages.at(-1)?.content;
		void chat.messages.at(-1)?.agents.length;
		if (!pane) return;
		if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 160) {
			pane.scrollTop = pane.scrollHeight;
		}
	});

	function ask(text: string) {
		chat.send(text);
	}

	function onedit(message: ChatMessage, text: string) {
		chat.edit(message, text);
	}
</script>

<Tooltip.Provider delayDuration={300}>
	<Sidebar.Provider>
		<ChatSidebar {chat} />

		<!--
			Split view. The panel is a sibling of the chat column rather than an
			overlay: the sketch has the conversation narrow to make room, so both
			stay readable and usable at once.
		-->
		<Sidebar.Inset class="flex h-dvh min-h-0 flex-row">
			<div class="flex min-w-0 flex-1 flex-col">
			<!-- Header -->
			<header
				class="bg-background/95 sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b px-3 backdrop-blur"
			>
				<Sidebar.Trigger />
				<Separator orientation="vertical" class="mx-1 h-6" />

				<div class="flex min-w-0 items-center gap-2">
					<Logo class="hidden h-4 w-auto shrink-0 sm:block" />
					{#if currentTitle}
						<span class="truncate text-sm font-medium">{currentTitle}</span>
					{:else}
						<span class="text-muted-foreground truncate text-sm">Neue Unterhaltung</span>
					{/if}
				</div>

				<div class="ml-auto flex items-center gap-1">
					<ModeToggle />

					{#if data.user}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="ghost" size="icon" aria-label="Konto">
										<Avatar.Root class="size-7">
											<Avatar.Fallback class="text-xs">{initials}</Avatar.Fallback>
										</Avatar.Root>
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end" class="w-56">
								<DropdownMenu.Label>
									<span class="block truncate">{data.user.name}</span>
									<span class="text-muted-foreground block truncate text-xs font-normal">
										{data.user.email}
									</span>
								</DropdownMenu.Label>
								<DropdownMenu.Separator />
								<DropdownMenu.Group>
									<DropdownMenu.Item onclick={() => (settingsOpen = true)}>
										<SettingsIcon />
										Einstellungen
									</DropdownMenu.Item>
									<DropdownMenu.Item onclick={() => (location.href = '/files')}>
										<FilesIcon />
										Generierte Dateien
									</DropdownMenu.Item>
									{#if canManage}
										<DropdownMenu.Item onclick={() => (location.href = '/management')}>
											<UsersIcon />
											Verwaltung
										</DropdownMenu.Item>
									{/if}
									{#if canAdminister}
										<DropdownMenu.Item onclick={() => (location.href = '/admin')}>
											<ShieldIcon />
											Administration
										</DropdownMenu.Item>
									{/if}
									<DropdownMenu.Item onclick={() => (location.href = '/logout')}>
										<LogOutIcon />
										Abmelden
									</DropdownMenu.Item>
								</DropdownMenu.Group>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					{/if}
				</div>
			</header>

			<!-- Messages -->
			<div bind:this={pane} class="min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
					{#if chat.messages.length === 0 && !chat.loading}
						<Empty.Root class="mt-[10vh]">
							<Empty.Header>
								<Empty.Media variant="icon">
									<MessageSquareIcon />
								</Empty.Media>
								<Empty.Title>Fragen Sie etwas über GSI</Empty.Title>
								<Empty.Description>
									Antworten stammen ausschließlich aus dem GSI-Wiki — mit Quellenangaben zum
									Nachlesen.
								</Empty.Description>
							</Empty.Header>
							<Empty.Content>
								<div class="flex flex-wrap justify-center gap-2">
									{#each SUGGESTIONS as suggestion (suggestion)}
										<Button variant="outline" size="sm" onclick={() => ask(suggestion)}>
											{suggestion}
										</Button>
									{/each}
								</div>
							</Empty.Content>
						</Empty.Root>
					{/if}

					{#each chat.messages as message, i (message.id ?? `pending-${i}`)}
						<Message
							{message}
							conversationId={chat.conversationId}
							latest={i === chat.messages.length - 1}
							busy={chat.busy || chat.loading}
							{onedit}
							onversion={(id) => chat.switchVersion(id)}
							onask={ask}
						/>
					{/each}
				</div>
			</div>

			<!-- Composer -->
			<div class="shrink-0">
				<Composer
					knowledgeBases={data.knowledgeBases}
					bind:mode={chat.mode}
					busy={chat.busy}
					onsubmit={(text, images, files) => chat.send(text, undefined, images, files)}

					onstop={() => chat.stop()}
				/>
			</div>
			</div>

			{#if viewer.isOpen && viewer.target}
				<aside
					class="bg-background flex w-full max-w-full min-w-0 shrink-0 flex-col gap-2 border-l p-3 lg:w-[46%] xl:w-[42%]"
				>
					<div class="flex items-center gap-2">
						<span class="truncate font-mono text-sm">{viewer.target.filename}</span>
						<Button
							variant="ghost"
							size="icon"
							class="ml-auto shrink-0"
							aria-label="Seitenbereich schließen"
							onclick={() => viewer.close()}
						>
							<XIcon />
						</Button>
					</div>
					<FileViewer
						mime={viewer.target.mime}
						filename={viewer.target.filename}
						language={viewer.target.language}
						content={viewer.target.content ?? ''}
						url={viewer.target.url}
						sourceUrl={viewer.target.sourceUrl}
					/>
				</aside>
			{/if}
		</Sidebar.Inset>

		<SettingsDialog bind:open={settingsOpen} />
	</Sidebar.Provider>
</Tooltip.Provider>
