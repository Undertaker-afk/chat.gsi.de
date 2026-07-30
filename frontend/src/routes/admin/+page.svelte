<script lang="ts">
	/**
	 * Administration (plan.md §8b).
	 *
	 * The admin decides what a department may reach AT MOST; managers subdivide
	 * that per person on /management. Everything here writes through /api/admin/*,
	 * which re-checks the role -- this page hides what you may not do, it does not
	 * decide it.
	 */
	import AdminShell from '$lib/components/AdminShell.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { Switch } from '$lib/components/ui/switch';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Separator } from '$lib/components/ui/separator';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import * as Empty from '$lib/components/ui/empty';
	import * as Alert from '$lib/components/ui/alert';
	import { Label } from '$lib/components/ui/label';
	import UsersIcon from '@lucide/svelte/icons/users';
	import UserCogIcon from '@lucide/svelte/icons/user-cog';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import BarChart3Icon from '@lucide/svelte/icons/bar-chart-3';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import SquareIcon from '@lucide/svelte/icons/square';
	import XIcon from '@lucide/svelte/icons/x';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import { Progress } from '$lib/components/ui/progress';
	import SaveIcon from '@lucide/svelte/icons/save';
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
	import { formatBytes } from '$lib/format';

	let { data } = $props();

	// Seeded from the server load once; every later change goes through the API
	// and updates these directly, so they are plain state rather than $derived.
	// svelte-ignore state_referenced_locally
	const initial = data;

	interface Group {
		id: number;
		name: string;
		description: string | null;
		members: number;
		managers: string[];
		kb_ids: number[];
	}
	interface Kb {
		id: number;
		slug: string;
		label: string;
		source_slug: string;
		is_default: boolean;
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
	interface DirectoryUser {
		sub: string;
		username: string;
		name: string;
		email: string;
		roles: string[];
		everLoggedIn: boolean;
	}

	let active = $state('groups');
	let groups = $state<Group[]>(initial.groups);
	let kbs = $state<Kb[]>(initial.knowledgeBases);
	let selected = $state<number | null>(initial.groups[0]?.id ?? null);
	let members = $state<Member[]>([]);
	let busy = $state(false);
	let message = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	const group = $derived(groups.find((g) => g.id === selected) ?? null);

	// --- writing ---------------------------------------------------------------

	/**
	 * Every write goes through here, and a failure is always reported.
	 *
	 * The bug this replaces: the "Standard" switch PATCHed
	 * /api/admin/knowledge-bases, which did not exist. The 404 fell through an
	 * `if (res.ok)` with no else, so the switch sprang back and said nothing --
	 * indistinguishable from "not allowed" or "nothing happened". A write that
	 * fails must never look like one that succeeded.
	 */
	async function send(url: string, method: string, body: unknown): Promise<any | null> {
		errorMessage = null;
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				...(body === undefined
					? {}
					: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
			});
		} catch (e) {
			errorMessage = `Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`;
			return null;
		}
		if (res.ok) return (await res.json().catch(() => ({}))) ?? {};
		const detail = await res.json().catch(() => null);
		errorMessage = detail?.message ?? `Speichern fehlgeschlagen (HTTP ${res.status})`;
		return null;
	}

	/** Same members regardless of order -- what "has the draft changed" means here. */
	const sameSet = (a: number[], b: number[]) =>
		a.length === b.length && a.every((x) => b.includes(x));

	const sweepMessage = (b: { hidden?: number; unhidden?: number }) =>
		b.hidden || b.unhidden
			? `Gespeichert. ${b.hidden ?? 0} Unterhaltung(en) ausgeblendet, ${b.unhidden ?? 0} wieder sichtbar.`
			: 'Gespeichert.';

	$effect(() => {
		if (selected !== null) loadMembers(selected);
	});

	async function refreshGroups() {
		const res = await fetch('/api/admin/groups');
		if (!res.ok) return;
		const body = await res.json();
		groups = body.groups;
		kbs = body.knowledgeBases;
		if (selected !== null && !groups.some((g) => g.id === selected)) {
			selected = groups[0]?.id ?? null;
		}
	}

	async function loadMembers(id: number) {
		const res = await fetch(`/api/admin/groups/${id}`);
		members = res.ok ? (await res.json()).members : [];
	}

	// --- groups ---------------------------------------------------------------

	let newName = $state('');
	let newDescription = $state('');

	async function createGroup() {
		if (!newName.trim()) return;
		busy = true;
		try {
			const body = await send('/api/admin/groups', 'POST', {
				name: newName.trim(),
				description: newDescription.trim()
			});
			if (!body) return;
			newName = '';
			newDescription = '';
			await refreshGroups();
			selected = body.id;
		} finally {
			busy = false;
		}
	}

	async function removeGroup(id: number) {
		busy = true;
		try {
			if (!(await send(`/api/admin/groups/${id}`, 'DELETE', undefined))) return;
			await refreshGroups();
		} finally {
			busy = false;
		}
	}

	// --- grants: the group's ceiling ------------------------------------------

	// Staged, not written on click. Re-seeded whenever the selected group or the
	// server's copy of it changes, so a save (or switching group) resets it.
	let grantDraft = $state<number[]>([]);
	$effect(() => {
		const g = groups.find((x) => x.id === selected);
		grantDraft = g ? [...g.kb_ids] : [];
	});

	const grantsDirty = $derived(group ? !sameSet(grantDraft, group.kb_ids) : false);

	function stageGrant(kbId: number, on: boolean) {
		grantDraft = on ? [...grantDraft, kbId] : grantDraft.filter((id) => id !== kbId);
	}

	/** The ceiling. Narrowing it can hide conversations, so we report the sweep. */
	async function saveGrants() {
		if (!group) return;
		busy = true;
		try {
			const body = await send(`/api/admin/groups/${group.id}/grants`, 'PUT', {
				kbIds: grantDraft
			});
			if (!body) return;
			message = sweepMessage(body);
			await refreshGroups();
		} finally {
			busy = false;
		}
	}

	function discardGrants() {
		grantDraft = group ? [...group.kb_ids] : [];
		errorMessage = null;
	}

	// --- members --------------------------------------------------------------

	let userQuery = $state('');
	let directory = $state<DirectoryUser[]>([]);
	let directoryError = $state<string | null>(null);
	let searching = $state(false);

	async function searchUsers() {
		searching = true;
		try {
			const res = await fetch(`/api/admin/users?q=${encodeURIComponent(userQuery)}`);
			if (!res.ok) return;
			const body = await res.json();
			directory = body.users;
			directoryError = body.directoryError;
		} finally {
			searching = false;
		}
	}

	// Adding and removing a person are actions with an immediate, visible result
	// (the row appears or disappears), so they stay direct rather than staged.
	async function addMember(sub: string) {
		if (!group) return;
		if (!(await send(`/api/admin/groups/${group.id}/members`, 'POST', { userSub: sub }))) return;
		await Promise.all([loadMembers(group.id), refreshGroups()]);
	}

	async function dropMember(sub: string) {
		if (!group) return;
		const url = `/api/admin/groups/${group.id}/members?userSub=${encodeURIComponent(sub)}`;
		if (!(await send(url, 'DELETE', undefined))) return;
		await Promise.all([loadMembers(group.id), refreshGroups()]);
	}

	// Staged manager flags, keyed by user. Re-seeded whenever members reload.
	let managerDraft = $state<Record<string, boolean>>({});
	$effect(() => {
		managerDraft = Object.fromEntries(members.map((m) => [m.user_sub, m.is_manager]));
	});

	const managersDirty = $derived(
		members.some((m) => managerDraft[m.user_sub] !== m.is_manager)
	);

	function stageManager(sub: string, isManager: boolean) {
		managerDraft = { ...managerDraft, [sub]: isManager };
	}

	async function saveManagers() {
		if (!group) return;
		busy = true;
		try {
			const changed = members.filter((m) => managerDraft[m.user_sub] !== m.is_manager);
			for (const m of changed) {
				// One request per member: the endpoint takes a single user. Stop at the
				// first failure rather than pressing on -- send() has already put the
				// reason on screen, and earlier writes in the loop still stand.
				const ok = await send(`/api/admin/groups/${group.id}/members`, 'PATCH', {
					userSub: m.user_sub,
					isManager: managerDraft[m.user_sub]
				});
				if (!ok) break;
			}
			if (!errorMessage) message = `Gespeichert: ${changed.length} Änderung(en).`;
			await Promise.all([loadMembers(group.id), refreshGroups()]);
		} finally {
			busy = false;
		}
	}

	function discardManagers() {
		managerDraft = Object.fromEntries(members.map((m) => [m.user_sub, m.is_manager]));
		errorMessage = null;
	}

	// --- sources, audit, stats ------------------------------------------------

	let sources = $state<Record<string, unknown>[]>([]);
	let audit = $state<Record<string, unknown>[]>([]);
	let stats = $state<Record<string, any> | null>(null);

	async function loadSources() {
		// /api/admin/crawl returns the sources WITH their control state, live run
		// and recent history in one round trip -- four separate fetches would make
		// the row flicker between inconsistent halves while polling.
		const res = await fetch('/api/admin/crawl');
		if (res.ok) sources = (await res.json()).sources;
	}

	/**
	 * Poll while a crawl is running.
	 *
	 * The crawler publishes a heartbeat every 5 s (migration 018) and a wiki crawl
	 * runs for hours, so this is the difference between a progress bar and a page
	 * somebody has to remember to reload. Polling stops the moment nothing is
	 * running: an idle admin tab must not query the database every three seconds
	 * for the rest of the day.
	 */
	const anyRunning = $derived(sources.some((s) => s.running));
	const anyPending = $derived(sources.some((s) => (s.pending as number) > 0));

	$effect(() => {
		if (active !== 'sources' || (!anyRunning && !anyPending)) return;
		const timer = setInterval(loadSources, anyRunning ? 3000 : 10000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (active === 'sources') loadSources();
		if (active === 'audit')
			fetch('/api/admin/audit').then(async (r) => {
				if (r.ok) audit = (await r.json()).entries;
			});
		if (active === 'stats')
			fetch('/api/admin/stats').then(async (r) => {
				if (r.ok) stats = await r.json();
			});
	});

	// --- knowledge bases: the public baseline ---------------------------------

	/** Staged default set: what someone with no group at all can search. */
	let defaultDraft = $state<number[]>([]);
	$effect(() => {
		defaultDraft = kbs.filter((kb) => kb.is_default).map((kb) => kb.id);
	});

	const savedDefaults = $derived(kbs.filter((kb) => kb.is_default).map((kb) => kb.id));
	const defaultsDirty = $derived(!sameSet(defaultDraft, savedDefaults));

	function stageDefault(id: number, isDefault: boolean) {
		defaultDraft = isDefault ? [...defaultDraft, id] : defaultDraft.filter((x) => x !== id);
	}

	async function saveDefaults() {
		busy = true;
		try {
			const body = await send('/api/admin/knowledge-bases', 'PUT', {
				defaultKbIds: defaultDraft
			});
			if (!body) return;
			if (body.knowledgeBases) kbs = body.knowledgeBases;
			message = sweepMessage(body);
			await refreshGroups();
		} finally {
			busy = false;
		}
	}

	function discardDefaults() {
		defaultDraft = savedDefaults;
		errorMessage = null;
	}

	// --- sources ---------------------------------------------------------------

	let sourceDraft = $state<Record<number, boolean>>({});
	$effect(() => {
		sourceDraft = Object.fromEntries(
			sources.map((s) => [s.id as number, s.enabled === true])
		);
	});

	const sourcesDirty = $derived(
		sources.some((s) => sourceDraft[s.id as number] !== (s.enabled === true))
	);

	function stageSource(id: number, enabled: boolean) {
		sourceDraft = { ...sourceDraft, [id]: enabled };
	}

	async function saveSources() {
		busy = true;
		try {
			const changed = sources.filter(
				(s) => sourceDraft[s.id as number] !== (s.enabled === true)
			);
			for (const s of changed) {
				const ok = await send('/api/admin/sources', 'PATCH', {
					id: s.id,
					enabled: sourceDraft[s.id as number]
				});
				if (!ok) break;
			}
			if (!errorMessage) message = `Gespeichert: ${changed.length} Änderung(en).`;
			await loadSources();
		} finally {
			busy = false;
		}
	}

	function discardSources() {
		sourceDraft = Object.fromEntries(sources.map((s) => [s.id as number, s.enabled === true]));
		errorMessage = null;
	}

	// --- crawler control -------------------------------------------------------
	//
	// These are actions, not edits: they have no draft state and take effect the
	// moment they are pressed, so they stay direct buttons rather than joining the
	// save bar. The wording matters -- the frontend cannot start a process, it
	// writes intent to the database and `crawler tick` acts on it, so "Start"
	// honestly says "eingereiht" rather than claiming a crawl is under way.

	const MODES = [
		{ id: 'changed-only', label: 'Nur Geändertes',
		  hint: 'Fragt die Quelle nach der Revision und lädt unveränderte Seiten gar nicht erst. Schonendste Variante.' },
		{ id: 'incremental', label: 'Inkrementell',
		  hint: 'Lädt jede Seite und vergleicht den Inhalts-Hash. Findet auch Änderungen ohne Revisionsangabe.' },
		{ id: 'skip-existing', label: 'Nur Neues',
		  hint: 'Überspringt alles Bekannte ungeprüft. Schnell, bemerkt aber keine Bearbeitungen.' },
		{ id: 'full', label: 'Vollständig',
		  hint: 'Lädt und embeddet alles neu, unabhängig vom Hash. Teuer — nur nach Modellwechsel.' }
	] as const;

	/** Per-source mode picker for the Start button. */
	let startMode = $state<Record<number, string>>({});
	const modeOf = (id: number) => startMode[id] ?? 'changed-only';

	async function crawlAction(id: number, action: string, extra: Record<string, unknown> = {}) {
		busy = true;
		try {
			const body = await send('/api/admin/crawl', 'POST', { id, action, ...extra });
			if (!body) return null;
			await loadSources();
			return body;
		} finally {
			busy = false;
		}
	}

	async function startCrawl(id: number) {
		const body = await crawlAction(id, 'start', { mode: modeOf(id) });
		if (!body) return;
		message = body.alreadyQueued
			? 'Für diese Quelle steht bereits ein Crawl in der Warteschlange.'
			: 'Crawl eingereiht — startet beim nächsten Crawler-Durchlauf (max. 5 Min).';
	}

	async function stopCrawl(id: number, slug: string) {
		// Confirmed because it is not free to undo: the run ends where it is and
		// the corpus keeps whatever it had, so restarting means crawling from the
		// beginning again -- hours, at the wiki's 5 s crawl delay.
		if (!confirm(`Crawl von „${slug}“ wirklich stoppen? Der Lauf endet an der nächsten Seite; bereits indexierte Seiten bleiben erhalten.`)) return;
		if (await crawlAction(id, 'stop')) {
			message = 'Stopp angefordert — der Lauf endet an der nächsten Seitengrenze.';
		}
	}

	async function pauseCrawl(id: number, paused: boolean) {
		if (await crawlAction(id, paused ? 'pause' : 'resume')) {
			message = paused
				? 'Pausiert. Ein laufender Crawl wartet, geplante Läufe starten nicht.'
				: 'Fortgesetzt.';
		}
	}

	async function cancelCrawl(id: number) {
		if (await crawlAction(id, 'cancel')) message = 'Warteschlange geleert.';
	}

	// --- schedule --------------------------------------------------------------
	//
	// The interval is an edit, so it gets a draft and a save button. Stored in
	// minutes; offered in the units people actually think in.

	const INTERVALS = [
		{ minutes: null, label: 'Kein Automatik-Crawl' },
		{ minutes: 60, label: 'Stündlich' },
		{ minutes: 360, label: 'Alle 6 Stunden' },
		{ minutes: 720, label: 'Alle 12 Stunden' },
		{ minutes: 1440, label: 'Täglich' },
		{ minutes: 4320, label: 'Alle 3 Tage' },
		{ minutes: 10080, label: 'Wöchentlich' },
		{ minutes: 43200, label: 'Monatlich' }
	] as const;

	let scheduleDraft = $state<Record<number, { interval: number | null; mode: string }>>({});

	$effect(() => {
		scheduleDraft = Object.fromEntries(
			sources.map((s) => {
				const c = s.control as { interval_minutes: number | null; mode: string } | null;
				return [s.id as number, { interval: c?.interval_minutes ?? null, mode: c?.mode ?? 'changed-only' }];
			})
		);
	});

	function scheduleChanged(s: Record<string, unknown>): boolean {
		const draft = scheduleDraft[s.id as number];
		const c = s.control as { interval_minutes: number | null; mode: string } | null;
		if (!draft) return false;
		return draft.interval !== (c?.interval_minutes ?? null) || draft.mode !== (c?.mode ?? 'changed-only');
	}

	function stageSchedule(id: number, patch: { interval?: number | null; mode?: string }) {
		const current = scheduleDraft[id] ?? { interval: null, mode: 'changed-only' };
		scheduleDraft = { ...scheduleDraft, [id]: { ...current, ...patch } };
	}

	async function saveSchedule(id: number) {
		const draft = scheduleDraft[id];
		if (!draft) return;
		if (await crawlAction(id, 'schedule', { intervalMinutes: draft.interval, mode: draft.mode })) {
			message = draft.interval === null
				? 'Automatik-Crawl abgeschaltet.'
				: 'Intervall gespeichert. Der erste automatische Lauf startet nach Ablauf des Intervalls.';
		}
	}

	// --- display helpers -------------------------------------------------------

	function relative(seconds: number | null | undefined): string {
		if (seconds === null || seconds === undefined) return '—';
		const s = Math.abs(Math.round(seconds));
		if (s < 60) return `${s} s`;
		if (s < 3600) return `${Math.round(s / 60)} Min`;
		if (s < 86400) return `${(s / 3600).toFixed(1)} Std`;
		return `${(s / 86400).toFixed(1)} Tage`;
	}

	const intervalLabel = (minutes: number | null | undefined) =>
		INTERVALS.find((i) => i.minutes === (minutes ?? null))?.label ??
		(minutes ? `Alle ${relative(minutes * 60)}` : 'Kein Automatik-Crawl');

	const modeLabel = (id: string | null | undefined) =>
		MODES.find((m) => m.id === id)?.label ?? id ?? '—';

	/**
	 * Progress against the previous run's page count.
	 *
	 * Deliberately an estimate and labelled as one: the crawler does not know how
	 * many pages discovery will yield until discovery ends, so the only honest
	 * denominator is what last time found. Capped at 99% so a run that outgrows
	 * its predecessor never shows a finished bar while it is still working.
	 */
	function progressPercent(s: Record<string, any>): number | null {
		const seen = s.running?.pages_seen ?? 0;
		const previous = (s.runs ?? []).find((r: any) => r.status !== 'running' && r.pages_seen > 0);
		if (!previous) return null;
		return Math.min(99, Math.round((seen / previous.pages_seen) * 100));
	}

	/** A heartbeat older than a minute means the crawler died, not that it is slow. */
	const heartbeatStale = (s: Record<string, any>) => (s.running?.heartbeat_age ?? 0) > 60;

	const RUN_STATUS: Record<string, { label: string; variant: 'secondary' | 'destructive' | 'outline' }> = {
		ok: { label: 'ok', variant: 'secondary' },
		partial: { label: 'teilweise', variant: 'outline' },
		failed: { label: 'fehlgeschlagen', variant: 'destructive' },
		stopped: { label: 'gestoppt', variant: 'outline' },
		running: { label: 'läuft', variant: 'outline' }
	};

	let expanded = $state<Record<number, boolean>>({});

	const SECTIONS = [
		{ id: 'groups', label: 'Gruppen', icon: UsersIcon, description: 'Zugriff festlegen' },
		{ id: 'members', label: 'Mitglieder', icon: UserCogIcon, description: 'Personen & Leitung' },
		{ id: 'kbs', label: 'Wissensbasen', icon: LibraryIcon, description: 'Standard für alle' },
		{ id: 'sources', label: 'Quellen', icon: DatabaseIcon, description: 'Crawls & Status' },
		{ id: 'audit', label: 'Protokoll', icon: ScrollTextIcon, description: 'Wer hat was geändert' },
		{ id: 'stats', label: 'Statistik', icon: BarChart3Icon }
	];

	const displayName = (m: Member | DirectoryUser) =>
		('name' in m && m.name) ||
		('username' in m && m.username) ||
		('user_sub' in m ? m.user_sub : '');
</script>

<svelte:head><title>Administration · chat.gsi.de</title></svelte:head>

<!--
	One save control for every staged section. Declared here rather than inside
	AdminShell: a snippet at a component's top level is a prop, not a local.
	Disabled until something actually differs from the server's copy, so
	"Speichern" being clickable is itself the unsaved-changes indicator.
-->
{#snippet saveBar(dirty: boolean, onSave: () => void, onDiscard: () => void)}
	<div class="flex items-center gap-2">
		{#if dirty}
			<span class="text-muted-foreground text-xs">Nicht gespeicherte Änderungen</span>
			<Button variant="ghost" size="sm" onclick={onDiscard} disabled={busy}>Verwerfen</Button>
		{/if}
		<Button size="sm" onclick={onSave} disabled={busy || !dirty}>
			{#if busy}
				<Spinner data-icon="inline-start" />
			{:else}
				<SaveIcon data-icon="inline-start" />
			{/if}
			Speichern
		</Button>
	</div>
{/snippet}

<AdminShell
	title="Administration"
	subtitle="Gruppen, Wissensbasen und Quellen"
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


	{#if active === 'groups'}
		<div class="grid gap-4 lg:grid-cols-[18rem_1fr]">
			<Card.Root>
				<Card.Header>
					<Card.Title>Gruppen</Card.Title>
					<Card.Description>Eine Gruppe pro Abteilung.</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-1">
					{#each groups as g (g.id)}
						<button
							type="button"
							class="hover:bg-muted flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm
								{selected === g.id ? 'bg-muted font-medium' : ''}"
							onclick={() => (selected = g.id)}
						>
							<span class="truncate">{g.name}</span>
							<span class="text-muted-foreground shrink-0 text-xs">{g.members}</span>
						</button>
					{:else}
						<p class="text-muted-foreground py-2 text-sm">Noch keine Gruppen.</p>
					{/each}
				</Card.Content>
				<Card.Footer class="flex-col items-stretch gap-2">
					<Separator />
					<div class="flex flex-col gap-2">
						<Label for="group-name">Neue Gruppe</Label>
						<Input id="group-name" bind:value={newName} placeholder="z. B. IT" />
						<Label for="group-desc">Beschreibung</Label>
						<Input id="group-desc" bind:value={newDescription} placeholder="optional" />
					</div>
					<Button onclick={createGroup} disabled={busy || !newName.trim()}>
						{#if busy}<Spinner data-icon="inline-start" />{:else}<PlusIcon
								data-icon="inline-start"
							/>{/if}
						Anlegen
					</Button>
				</Card.Footer>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>{group?.name ?? 'Keine Gruppe gewählt'}</Card.Title>
					<Card.Description>
						Obergrenze der Gruppe. Abteilungsleitungen können daraus je Person eine Teilmenge
						vergeben — niemals mehr.
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-2">
					{#if group}
						{#each kbs as kb (kb.id)}
							<label class="hover:bg-muted/60 flex items-center gap-3 rounded-md px-2 py-1.5">
								<Checkbox
									checked={grantDraft.includes(kb.id)}
									disabled={busy}
									onCheckedChange={(v) => stageGrant(kb.id, v === true)}
								/>
								<span class="flex min-w-0 flex-1 items-center gap-2">
									<span class="truncate text-sm">{kb.label}</span>
									<span class="text-muted-foreground text-xs">{kb.source_slug}</span>
									{#if kb.is_default}
										<Badge variant="secondary">Standard</Badge>
									{/if}
								</span>
								<span class="text-muted-foreground shrink-0 text-xs tabular-nums">
									{kb.documents} Seiten
								</span>
							</label>
						{/each}
					{:else}
						<Empty.Root class="py-8">
							<Empty.Header>
								<Empty.Media variant="icon"><UsersIcon /></Empty.Media>
								<Empty.Title>Keine Gruppe gewählt</Empty.Title>
							</Empty.Header>
						</Empty.Root>
					{/if}
				</Card.Content>
				{#if group}
					<Card.Footer class="flex-col items-stretch gap-3">
						<div class="flex items-center justify-between gap-2">
							<p class="text-muted-foreground text-xs">
								Standard-Wissensbasen erhält jede angemeldete Person auch ohne Gruppe.
							</p>
							{@render saveBar(grantsDirty, saveGrants, discardGrants)}
						</div>
						<Separator />
						<Button
							variant="ghost"
							size="sm"
							class="text-muted-foreground hover:text-destructive self-end"
							onclick={() => removeGroup(group.id)}
						>
							<Trash2Icon data-icon="inline-start" />
							Gruppe löschen
						</Button>
					</Card.Footer>
				{/if}
			</Card.Root>
		</div>
	{:else if active === 'members'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Mitglieder von {group?.name ?? '—'}</Card.Title>
				<Card.Description>
					Wer in der Gruppe ist, und wer sie leitet. Leitung setzt zusätzlich die Rolle
					<code>llmbot-privileged</code> in Keycloak voraus.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{#if members.length}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Person</Table.Head>
								<Table.Head>Zugriff</Table.Head>
								<Table.Head class="w-28">Leitung</Table.Head>
								<Table.Head class="w-10"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each members as m (m.user_sub)}
								<Table.Row>
									<Table.Cell>
										<span class="flex flex-col">
											<span class="text-sm">{displayName(m)}</span>
											<span class="text-muted-foreground text-xs">{m.email ?? m.user_sub}</span>
										</span>
									</Table.Cell>
									<Table.Cell class="text-muted-foreground text-xs">
										{m.restricted
											? `${m.kb_ids.length} von ${group?.kb_ids.length ?? 0}`
											: 'volle Gruppenrechte'}
									</Table.Cell>
									<Table.Cell>
										<Switch
											checked={managerDraft[m.user_sub] ?? m.is_manager}
											disabled={busy}
											onCheckedChange={(v) => stageManager(m.user_sub, v === true)}
										/>
									</Table.Cell>
									<Table.Cell>
										<Button
											variant="ghost"
											size="icon"
											class="text-muted-foreground hover:text-destructive"
											aria-label="Aus Gruppe entfernen"
											onclick={() => dropMember(m.user_sub)}
										>
											<Trash2Icon />
										</Button>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
					<div class="flex justify-end">
						{@render saveBar(managersDirty, saveManagers, discardManagers)}
					</div>
				{:else}
					<p class="text-muted-foreground text-sm">Diese Gruppe hat noch keine Mitglieder.</p>
				{/if}

				<Separator />

				<div class="flex flex-col gap-2">
					<div class="flex gap-2">
						<Input
							bind:value={userQuery}
							placeholder="Person suchen (Name, Benutzername, E-Mail)"
							onkeydown={(e) => e.key === 'Enter' && searchUsers()}
						/>
						<Button variant="secondary" onclick={searchUsers} disabled={searching}>
							{#if searching}<Spinner data-icon="inline-start" />{/if}
							Suchen
						</Button>
					</div>

					{#if directoryError}
						<Alert.Root variant="destructive">
							<Alert.Description>
								Verzeichnis nicht erreichbar ({directoryError}). Es werden nur Personen angezeigt,
								die sich bereits angemeldet haben.
							</Alert.Description>
						</Alert.Root>
					{/if}

					{#each directory as u (u.sub)}
						<div class="hover:bg-muted/60 flex items-center gap-3 rounded-md px-2 py-1.5">
							<span class="flex min-w-0 flex-1 flex-col">
								<span class="truncate text-sm">{u.name || u.username}</span>
								<span class="text-muted-foreground truncate text-xs">
									{u.email}
									{#if !u.everLoggedIn}· noch nie angemeldet{/if}
								</span>
							</span>
							{#each u.roles.filter((r) => r.startsWith('llmbot-')) as role (role)}
								<Badge variant="outline">{role.replace('llmbot-', '')}</Badge>
							{/each}
							<Button
								size="sm"
								variant="secondary"
								disabled={!group || members.some((m) => m.user_sub === u.sub)}
								onclick={() => addMember(u.sub)}
							>
								Hinzufügen
							</Button>
						</div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	{:else if active === 'kbs'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Wissensbasen</Card.Title>
				<Card.Description>
					Eine je Foswiki-Web plus eine je sonstiger Quelle. „Standard“ erhält jede angemeldete
					Person auch ohne Gruppe — alles andere muss über eine Gruppe vergeben werden.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Wissensbasis</Table.Head>
							<Table.Head>Quelle</Table.Head>
							<Table.Head class="w-24">Seiten</Table.Head>
							<Table.Head class="w-32">Standard</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each kbs as kb (kb.id)}
							<Table.Row>
								<Table.Cell class="text-sm">{kb.label}</Table.Cell>
								<Table.Cell class="text-muted-foreground text-xs">{kb.source_slug}</Table.Cell>
								<Table.Cell class="tabular-nums">{kb.documents}</Table.Cell>
								<Table.Cell>
									<Switch
										checked={defaultDraft.includes(kb.id)}
										disabled={busy}
										onCheckedChange={(v) => stageDefault(kb.id, v === true)}
									/>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
			<Card.Footer class="justify-end">
				{@render saveBar(defaultsDirty, saveDefaults, discardDefaults)}
			</Card.Footer>
		</Card.Root>
	{:else if active === 'sources'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Quellen &amp; Crawler</Card.Title>
				<Card.Description>
					Der Crawler läuft in einem eigenen Container. Diese Seite schreibt die
					gewünschte Aktion in die Datenbank; der Crawler holt sie sich beim nächsten
					Durchlauf (höchstens fünf Minuten) ab. Ein laufender Crawl reagiert auf
					Pause und Stopp jeweils an der nächsten Seitengrenze.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#each sources as s (s.id)}
					{@const running = s.running as Record<string, any> | null}
					{@const control = (s.control ?? {}) as Record<string, any>}
					{@const pending = (s.pending as number) ?? 0}
					{@const draft = scheduleDraft[s.id as number] ?? { interval: null, mode: 'changed-only' }}
					{@const runs = (s.runs ?? []) as Record<string, any>[]}
					<div class="rounded-lg border p-4">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium">{s.slug}</span>
									{#if running}
										<Badge variant="outline" class="gap-1">
											<ActivityIcon class="size-3 animate-pulse" />
											läuft · {modeLabel(running.mode)}
										</Badge>
									{:else if pending > 0}
										<Badge variant="outline">eingereiht</Badge>
									{:else if control.desired_state === 'paused'}
										<Badge variant="outline">pausiert</Badge>
									{/if}
									{#if control.stop_requested_at}
										<Badge variant="destructive">Stopp angefordert</Badge>
									{/if}
								</div>
								<span class="text-muted-foreground text-xs">{s.base_url}</span>
							</div>

							<div class="flex flex-wrap items-center gap-2">
								{#if running}
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onclick={() => pauseCrawl(s.id as number, control.desired_state !== 'paused')}
									>
										{#if control.desired_state === 'paused'}
											<PlayIcon data-icon="inline-start" /> Fortsetzen
										{:else}
											<PauseIcon data-icon="inline-start" /> Pause
										{/if}
									</Button>
									<Button
										size="sm"
										variant="destructive"
										disabled={busy || !!control.stop_requested_at}
										onclick={() => stopCrawl(s.id as number, String(s.slug))}
									>
										<SquareIcon data-icon="inline-start" /> Stopp
									</Button>
								{:else if pending > 0}
									<Button size="sm" variant="outline" disabled={busy} onclick={() => cancelCrawl(s.id as number)}>
										<XIcon data-icon="inline-start" /> Aus Warteschlange nehmen
									</Button>
								{:else}
									<!-- Native select: the design system has no Select component, and
									     a dropdown-menu here would be four files for one picker. -->
									<select
										class="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
										value={modeOf(s.id as number)}
										disabled={busy}
										title={MODES.find((m) => m.id === modeOf(s.id as number))?.hint}
										onchange={(e) =>
											(startMode = { ...startMode, [s.id as number]: e.currentTarget.value })}
									>
										{#each MODES as m (m.id)}
											<option value={m.id}>{m.label}</option>
										{/each}
									</select>
									<Button
										size="sm"
										variant="secondary"
										disabled={busy || s.enabled !== true}
										title={s.enabled === true ? undefined : 'Quelle ist deaktiviert'}
										onclick={() => startCrawl(s.id as number)}
									>
										<PlayIcon data-icon="inline-start" /> Crawl starten
									</Button>
								{/if}
								<Switch
									checked={sourceDraft[s.id as number] ?? s.enabled === true}
									disabled={busy}
									onCheckedChange={(v) => stageSource(s.id as number, v === true)}
								/>
							</div>
						</div>

						{#if running}
							{@const percent = progressPercent(s)}
							<div class="mt-3 space-y-1.5">
								<Progress value={percent ?? 0} />
								<div class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
									<span>
										{running.pages_seen} Seiten gesehen{percent !== null ? ` · ca. ${percent}%` : ''}
									</span>
									<span>{running.pages_changed} geändert</span>
									<span>{running.pages_unfetched} nicht geladen</span>
									{#if running.pages_failed > 0}
										<span class="text-destructive">{running.pages_failed} fehlgeschlagen</span>
									{/if}
									<span>{running.chunks_written} Chunks</span>
									<span>seit {relative(running.elapsed ?? null)}</span>
									{#if heartbeatStale(s)}
										<span class="text-destructive">
											kein Lebenszeichen seit {relative(running.heartbeat_age)} — Crawler vermutlich abgestürzt
										</span>
									{/if}
								</div>
								{#if percent === null}
									<p class="text-muted-foreground text-xs">
										Kein Vergleichslauf vorhanden — der Fortschritt lässt sich erst ab dem
										zweiten Crawl schätzen.
									</p>
								{/if}
							</div>
						{/if}

						<Separator class="my-3" />

						<div class="flex flex-wrap items-end gap-3">
							<div class="space-y-1">
								<Label class="text-xs">Automatik-Crawl</Label>
								<select
									class="border-input bg-background h-9 rounded-md border px-2 text-sm"
									value={String(draft.interval)}
									disabled={busy}
									onchange={(e) =>
										stageSchedule(s.id as number, {
											interval: e.currentTarget.value === 'null' ? null : Number(e.currentTarget.value)
										})}
								>
									{#each INTERVALS as i (String(i.minutes))}
										<option value={String(i.minutes)}>{i.label}</option>
									{/each}
								</select>
							</div>
							<div class="space-y-1">
								<Label class="text-xs">Modus für Automatik</Label>
								<select
									class="border-input bg-background h-9 rounded-md border px-2 text-sm"
									value={draft.mode}
									disabled={busy || draft.interval === null}
									onchange={(e) => stageSchedule(s.id as number, { mode: e.currentTarget.value })}
								>
									{#each MODES as m (m.id)}
										<option value={m.id}>{m.label}</option>
									{/each}
								</select>
							</div>
							{#if scheduleChanged(s)}
								<Button size="sm" disabled={busy} onclick={() => saveSchedule(s.id as number)}>
									<SaveIcon data-icon="inline-start" /> Intervall speichern
								</Button>
							{/if}
							<div class="text-muted-foreground ml-auto text-right text-xs">
								<div class="flex items-center justify-end gap-1">
									<ClockIcon class="size-3" />
									{intervalLabel(control.interval_minutes)}
								</div>
								{#if control.next_run_at && control.interval_minutes}
									<div>
										nächster Lauf in {relative(
											(new Date(control.next_run_at as string).getTime() - Date.now()) / 1000
										)}
									</div>
								{/if}
							</div>
						</div>

						<div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
							<span class="tabular-nums">{s.documents} Seiten indexiert</span>
							<span class="text-muted-foreground tabular-nums">
								{s.documents_with_revision} mit Revision
								{#if (s.documents as number) > 0 && (s.documents_with_revision as number) === 0}
									— „Nur Geändertes“ wirkt erst nach einem vollen Lauf
								{/if}
							</span>
							{#if s.last_run}
								<span class="text-muted-foreground">
									zuletzt {new Date(s.last_run as string).toLocaleString('de-DE')}
								</span>
							{/if}
							{#if s.last_status}
								<Badge variant={RUN_STATUS[s.last_status as string]?.variant ?? 'outline'}>
									{RUN_STATUS[s.last_status as string]?.label ?? s.last_status}
								</Badge>
							{/if}
							<Button
								size="sm"
								variant="ghost"
								class="ml-auto h-7 px-2"
								onclick={() =>
									(expanded = { ...expanded, [s.id as number]: !expanded[s.id as number] })}
							>
								<ChevronDownIcon
									class="size-3 transition-transform {expanded[s.id as number] ? 'rotate-180' : ''}"
								/>
								Letzte Läufe
							</Button>
						</div>

						{#if expanded[s.id as number]}
							<Table.Root class="mt-2">
								<Table.Header>
									<Table.Row>
										<Table.Head>Start</Table.Head>
										<Table.Head>Modus</Table.Head>
										<Table.Head>Status</Table.Head>
										<Table.Head class="text-right">gesehen</Table.Head>
										<Table.Head class="text-right">geändert</Table.Head>
										<Table.Head class="text-right">nicht geladen</Table.Head>
										<Table.Head class="text-right">gelöscht</Table.Head>
										<Table.Head class="text-right">Chunks</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each runs as r (r.id)}
										<Table.Row>
											<Table.Cell class="text-xs">
												{new Date(r.started_at as string).toLocaleString('de-DE')}
											</Table.Cell>
											<Table.Cell class="text-xs">{modeLabel(r.mode)}</Table.Cell>
											<Table.Cell>
												<Badge variant={RUN_STATUS[r.status as string]?.variant ?? 'outline'}>
													{RUN_STATUS[r.status as string]?.label ?? r.status}
												</Badge>
												{#if r.error}
													<span class="text-muted-foreground ml-1 text-xs">{r.error}</span>
												{/if}
											</Table.Cell>
											<Table.Cell class="text-right tabular-nums">{r.pages_seen}</Table.Cell>
											<Table.Cell class="text-right tabular-nums">{r.pages_changed}</Table.Cell>
											<Table.Cell class="text-right tabular-nums">{r.pages_unfetched}</Table.Cell>
											<Table.Cell class="text-right tabular-nums">{r.pages_deleted}</Table.Cell>
											<Table.Cell class="text-right tabular-nums">{r.chunks_written}</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{/if}
					</div>
				{/each}
			</Card.Content>
			<Card.Footer class="justify-between">
				<p class="text-muted-foreground max-w-xl text-xs">
					„Nur Geändertes“ fragt die Quelle nach ihrer Revision und lädt unveränderte
					Seiten gar nicht erst — bei fünf Sekunden Wartezeit pro Abruf ist das der
					Unterschied zwischen Minuten und Stunden. Ein gestoppter Lauf löscht nie:
					er hat nur einen Teil der Seiten gesehen, und alles danach würde
					fälschlich als gelöscht gelten.
				</p>
				{@render saveBar(sourcesDirty, saveSources, discardSources)}
			</Card.Footer>
		</Card.Root>
	{:else if active === 'audit'}
		<Card.Root>
			<Card.Header>
				<Card.Title>Protokoll</Card.Title>
				<Card.Description>Jede Rechteänderung, mit Person und Zeitpunkt.</Card.Description>
			</Card.Header>
			<Card.Content>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="w-44">Zeitpunkt</Table.Head>
							<Table.Head>Wer</Table.Head>
							<Table.Head>Aktion</Table.Head>
							<Table.Head>Betrifft</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each audit as e (e.id)}
							<Table.Row>
								<Table.Cell class="text-muted-foreground text-xs">
									{new Date(e.at as string).toLocaleString('de-DE')}
								</Table.Cell>
								<Table.Cell class="text-sm">{e.actor_name ?? e.actor_sub}</Table.Cell>
								<Table.Cell><Badge variant="outline">{e.action}</Badge></Table.Cell>
								<Table.Cell class="text-muted-foreground truncate text-xs"
									>{e.target ?? ''}</Table.Cell
								>
							</Table.Row>
						{:else}
							<Table.Row>
								<Table.Cell colspan={4} class="text-muted-foreground py-6 text-center text-sm">
									Noch keine Einträge.
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{:else if active === 'stats'}
		{#if stats}
			<div class="grid gap-4 md:grid-cols-2">
				<Card.Root>
					<Card.Header><Card.Title>Korpus</Card.Title></Card.Header>
					<Card.Content class="flex flex-col gap-2 text-sm">
						{#each stats.corpus as c (c.slug)}
							<div class="flex items-baseline justify-between gap-2">
								<span>{c.slug}</span>
								<span class="text-muted-foreground text-xs tabular-nums">
									{c.documents} Seiten · {c.chunks} Chunks ·
									{c.last_document ? new Date(c.last_document).toLocaleDateString('de-DE') : '—'}
								</span>
							</div>
						{/each}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header><Card.Title>Nutzung (14 Tage)</Card.Title></Card.Header>
					<Card.Content class="flex flex-col gap-1 text-sm">
						{#each stats.usage as u (u.day)}
							<div class="flex items-baseline justify-between gap-2">
								<span class="text-muted-foreground text-xs">
									{new Date(u.day).toLocaleDateString('de-DE')}
								</span>
								<span class="text-xs tabular-nums">{u.fast} schnell · {u.deep} gründlich</span>
							</div>
						{:else}
							<p class="text-muted-foreground text-xs">Noch keine Fragen.</p>
						{/each}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header><Card.Title>Qualität</Card.Title></Card.Header>
					<Card.Content class="flex gap-6 text-sm">
						<span>👍 {stats.quality.up}</span>
						<span>👎 {stats.quality.down}</span>
						<span class="text-muted-foreground">
							{stats.quality.uncited} Antworten ohne Quelle
						</span>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header><Card.Title>Speicher & Personen</Card.Title></Card.Header>
					<Card.Content class="flex flex-col gap-1 text-sm">
						<span>{stats.storage.users} Konten · {stats.storage.conversations} Unterhaltungen</span>
						<span class="text-muted-foreground text-xs">
							{stats.storage.files} Dateien · {formatBytes(stats.storage.upload_bytes)} ·
							{stats.storage.hidden} ausgeblendet
						</span>
					</Card.Content>
				</Card.Root>
			</div>
		{:else}
			<div class="text-muted-foreground flex items-center gap-2 py-6 text-sm">
				<Spinner class="size-4" /> Wird geladen…
			</div>
		{/if}
	{/if}
</AdminShell>
