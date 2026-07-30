<script lang="ts">
	import type { ChatSession } from '$lib/chat.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import Logo from './Logo.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import MoreHorizontalIcon from '@lucide/svelte/icons/more-horizontal';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';

	let { chat }: { chat: ChatSession } = $props();

	let renaming = $state<string | null>(null);
	let draftTitle = $state('');

	/** Group by recency so a long history stays scannable. */
	const groups = $derived.by(() => {
		const now = Date.now();
		const day = 86_400_000;
		const buckets: Record<string, typeof chat.conversations> = {
			Heute: [],
			Gestern: [],
			'Letzte 7 Tage': [],
			Älter: []
		};
		for (const c of chat.conversations) {
			const age = now - new Date(c.updatedAt).getTime();
			const key =
				age < day ? 'Heute' : age < 2 * day ? 'Gestern' : age < 7 * day ? 'Letzte 7 Tage' : 'Älter';
			buckets[key].push(c);
		}
		return Object.entries(buckets).filter(([, list]) => list.length > 0);
	});

	function startRename(id: string, current: string | null) {
		renaming = id;
		draftTitle = current ?? '';
	}

	async function commitRename(id: string) {
		const title = draftTitle.trim();
		renaming = null;
		if (title) await chat.rename(id, title);
	}
</script>

<Sidebar.Root collapsible="offcanvas">
	<Sidebar.Header>
		<div class="flex items-center gap-2 px-2 py-1">
			<Logo class="h-4 w-auto" />
			<span class="text-muted-foreground text-sm">Assistant</span>
		</div>
		<Button
			variant="outline"
			class="w-full justify-start"
			onclick={() => chat.reset()}
			disabled={chat.busy}
		>
			<PlusIcon data-icon="inline-start" />
			Neue Unterhaltung
		</Button>
	</Sidebar.Header>

	<Sidebar.Content>
		{#if chat.conversations.length === 0}
			<p class="text-muted-foreground px-4 py-3 text-sm">Noch keine Unterhaltungen.</p>
		{/if}

		{#each groups as [label, items] (label)}
			<Sidebar.Group>
				<Sidebar.GroupLabel>{label}</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each items as conversation (conversation.id)}
							<Sidebar.MenuItem>
								{#if renaming === conversation.id}
									<!-- svelte-ignore a11y_autofocus -->
									<Input
										bind:value={draftTitle}
										autofocus
										class="h-8"
										onblur={() => commitRename(conversation.id)}
										onkeydown={(e) => {
											if (e.key === 'Enter') commitRename(conversation.id);
											if (e.key === 'Escape') renaming = null;
										}}
									/>
								{:else}
									<Sidebar.MenuButton
										isActive={chat.conversationId === conversation.id}
										onclick={() => chat.open(conversation.id)}
									>
										<MessageSquareIcon />
										<span class="truncate">
											{conversation.title ?? 'Ohne Titel'}
										</span>
									</Sidebar.MenuButton>

									<DropdownMenu.Root>
										<DropdownMenu.Trigger>
											{#snippet child({ props })}
												<Sidebar.MenuAction {...props} showOnHover aria-label="Aktionen">
													<MoreHorizontalIcon />
												</Sidebar.MenuAction>
											{/snippet}
										</DropdownMenu.Trigger>
										<DropdownMenu.Content side="right" align="start" class="w-44">
											<DropdownMenu.Group>
												<DropdownMenu.Item
													onclick={() => startRename(conversation.id, conversation.title)}
												>
													<PencilIcon />
													Umbenennen
												</DropdownMenu.Item>
												<DropdownMenu.Item
													variant="destructive"
													onclick={() => chat.remove(conversation.id)}
												>
													<Trash2Icon />
													Löschen
												</DropdownMenu.Item>
											</DropdownMenu.Group>
										</DropdownMenu.Content>
									</DropdownMenu.Root>
								{/if}
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/each}
	</Sidebar.Content>
</Sidebar.Root>
