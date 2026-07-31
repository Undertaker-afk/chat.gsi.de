<script lang="ts">
	/**
	 * Verwaltung — the department manager's view (plan.md §8b).
	 *
	 * A manager sees only the groups they manage and only the knowledge bases
	 * inside those groups' ceilings. Granting anything beyond the ceiling is
	 * refused by the server, so the checkboxes here are a convenience, not the
	 * boundary.
	 */
	import AdminShell from '$lib/components/AdminShell.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Separator } from '$lib/components/ui/separator';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import * as Alert from '$lib/components/ui/alert';
	import UsersIcon from '@lucide/svelte/icons/users';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import InfoIcon from '@lucide/svelte/icons/info';
	import SaveIcon from '@lucide/svelte/icons/save';
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
	import { t } from '$lib/language.svelte';

	let { data } = $props();

	interface Group {
		id: number;
		name: string;
		description: string | null;
		members: number;
		kb_ids: number[];
	}
	interface Kb {
		id: number;
		label: string;
		source_slug: string;
		documents: number;
	}
	interface Member {
		user_sub: string;
		username: string | null;
		name: string | null;
		email: string | null;
		is_manager: boolean;
		restricted: boolean;
		kb_ids: number[];
	}

	// svelte-ignore state_referenced_locally
	const initial = data;

	let groups = $state<Group[]>(initial.groups);
	let kbs = $state<Kb[]>(initial.knowledgeBases);
	let active = $state<string>(String(initial.groups[0]?.id ?? ''));
	let members = $state<Member[]>([]);
	let loading = $state(false);
	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	const group = $derived(groups.find((g) => String(g.id) === active) ?? null);
	const ceiling = $derived(group ? kbs.filter((kb) => group.kb_ids.includes(kb.id)) : []);

	$effect(() => {
		if (group) loadMembers(group.id);
	});

	async function loadMembers(id: number) {
		loading = true;
		try {
			const res = await fetch(`/api/management/groups/${id}/members`);
			members = res.ok ? (await res.json()).members : [];
		} finally {
			loading = false;
		}
	}

	/**
	 * Staged access per member. `null` means "full group rights" -- which is not
	 * the same as ticking every box, because it keeps following the ceiling as
	 * the administration widens or narrows it.
	 *
	 * Nothing is written on click. Each member row has its own save button, so a
	 * half-finished edit is visible as unsaved rather than applied a box at a time.
	 */
	let draft = $state<Record<string, number[] | null>>({});
	$effect(() => {
		draft = Object.fromEntries(
			members.map((m) => [m.user_sub, m.restricted ? [...m.kb_ids] : null])
		);
	});

	const sameSet = (a: number[], b: number[]) =>
		a.length === b.length && a.every((x) => b.includes(x));

	function isDirty(member: Member): boolean {
		const staged = draft[member.user_sub];
		const saved = member.restricted ? member.kb_ids : null;
		if (staged === null || saved === null) return staged !== saved;
		return !sameSet(staged, saved);
	}

	const checkedFor = (member: Member, kbId: number) => {
		const staged = draft[member.user_sub];
		return staged === null || staged === undefined ? true : staged.includes(kbId);
	};

	function stage(member: Member, kbId: number, on: boolean) {
		// First tick on an unrestricted member starts from the full ceiling, so
		// unticking one knowledge base removes exactly that one.
		const current = draft[member.user_sub] ?? ceiling.map((kb) => kb.id);
		const next = on ? [...current, kbId] : current.filter((id) => id !== kbId);
		draft = { ...draft, [member.user_sub]: next };
	}

	/** Stage a return to the group ceiling. Applied by the row's save button. */
	function stageFullRights(member: Member) {
		draft = { ...draft, [member.user_sub]: null };
	}

	function discard(member: Member) {
		draft = {
			...draft,
			[member.user_sub]: member.restricted ? [...member.kb_ids] : null
		};
		errorMessage = null;
	}

	async function save(member: Member) {
		if (!group) return;
		busy = member.user_sub;
		errorMessage = null;
		try {
			let res: Response;
			try {
				res = await fetch(`/api/management/groups/${group.id}/members`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ userSub: member.user_sub, kbIds: draft[member.user_sub] })
				});
			} catch (e) {
				errorMessage = t('management.networkError', { error: e instanceof Error ? e.message : String(e) });
				return;
			}
			if (!res.ok) {
				// Never silent: a failed save used to be indistinguishable from a
				// no-op, which is how a broken endpoint went unnoticed on /admin.
				const detail = await res.json().catch(() => null);
				errorMessage = detail?.message ?? t('management.saveFailed', { status: String(res.status) });
				return;
			}
			const body = await res.json();
			message = body.hidden
				? t('management.savedHidden', { count: body.hidden, days: 30 })
				: body.unhidden
					? t('management.savedUnhidden', { count: body.unhidden })
					: t('common.saved');
			await loadMembers(group.id);
		} finally {
			busy = null;
		}
	}

	const displayName = (m: Member) => m.name || m.username || m.user_sub;

	const SECTIONS = $derived(
		groups.map((g) => ({
			id: String(g.id),
			label: g.name,
			icon: UsersIcon,
			description: t('management.members', { count: g.members })
		}))
	);
</script>

<svelte:head><title>Verwaltung · chat.gsi.de</title></svelte:head>

<AdminShell
	title="Verwaltung"
	subtitle="Zugriff Ihrer Abteilung auf Wissensbasen"
	sections={SECTIONS}
	bind:active
>
	{#if errorMessage}
		<Alert.Root variant="destructive">
			<AlertTriangleIcon />
			<Alert.Description>{errorMessage}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if message}
		<Alert.Root>
			<ShieldIcon />
			<Alert.Description>{message}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if groups.length === 0}
		<Empty.Root class="py-12">
			<Empty.Header>
				<Empty.Media variant="icon"><UsersIcon /></Empty.Media>
				<Empty.Title>{t('management.noGroup')}</Empty.Title>
			<Empty.Description>
				{t('management.noGroupDescription')}
			</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if group}
		<Card.Root>
			<Card.Header>
				<Card.Title>{group.name}</Card.Title>
				<Card.Description>
					{group.description ?? t('management.personAccess')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<Alert.Root>
					<InfoIcon />
					<Alert.Description>
						{t('management.ceilingInfo', { count: ceiling.length })}
					</Alert.Description>
				</Alert.Root>

				{#if loading}
					<div class="text-muted-foreground flex items-center gap-2 py-6 text-sm">
						<Spinner class="size-4" /> {t('common.loading')}
					</div>
				{:else if members.length === 0}
					<p class="text-muted-foreground text-sm">{t('management.noMembers')}</p>
				{:else}
					{#each members as member (member.user_sub)}
						<div class="flex flex-col gap-3 rounded-lg border p-3">
							<div class="flex items-center justify-between gap-2">
								<span class="flex min-w-0 flex-col">
									<span class="flex items-center gap-2 text-sm font-medium">
										{displayName(member)}
										{#if member.is_manager}
											<Badge variant="secondary">{t('management.manager')}</Badge>
										{/if}
									</span>
									<span class="text-muted-foreground truncate text-xs">
										{member.email ?? member.user_sub}
									</span>
								</span>

								<div class="flex items-center gap-2">
									{#if busy === member.user_sub}
										<Spinner class="size-4" />
									{/if}
									{#if draft[member.user_sub] === null}
										<Badge variant="outline">{t('management.fullRights')}</Badge>
									{:else}
										<Button
											variant="ghost"
											size="sm"
											disabled={busy === member.user_sub}
											onclick={() => stageFullRights(member)}
										>
											{t('management.grantFullRights')}
										</Button>
									{/if}
								</div>
							</div>

							<Separator />

							<div class="flex flex-wrap gap-x-6 gap-y-2">
								{#each ceiling as kb (kb.id)}
									<label class="flex items-center gap-2 text-sm">
										<Checkbox
											checked={checkedFor(member, kb.id)}
											disabled={busy === member.user_sub}
											onCheckedChange={(v) => stage(member, kb.id, v === true)}
										/>
										{kb.label}
										<span class="text-muted-foreground text-xs">{kb.source_slug}</span>
									</label>
								{:else}
									<p class="text-muted-foreground text-sm">
										{t('management.noKbAssigned')}
									</p>
								{/each}
							</div>

							<div class="flex items-center justify-end gap-2">
								{#if isDirty(member)}
									<span class="text-muted-foreground text-xs">{t('management.unsaved')}</span>
									<Button
										variant="ghost"
										size="sm"
										disabled={busy === member.user_sub}
										onclick={() => discard(member)}
									>
										{t('management.discard')}
									</Button>
								{/if}
								<Button
									size="sm"
									disabled={busy === member.user_sub || !isDirty(member)}
									onclick={() => save(member)}
								>
									{#if busy === member.user_sub}
										<Spinner data-icon="inline-start" />
									{:else}
										<SaveIcon data-icon="inline-start" />
									{/if}
									{t('common.save')}
								</Button>
							</div>
						</div>
					{/each}
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</AdminShell>
