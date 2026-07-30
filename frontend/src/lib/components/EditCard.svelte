<script lang="ts">
	/**
	 * One proposed change to a generated file, as a diff with an apply button.
	 *
	 * Not applied automatically. The model is proposing an edit to a file the user
	 * deliberately kept -- often a job script they are about to submit -- and a
	 * silent overwrite would be a change they never saw. One click is cheap; an
	 * unnoticed rewrite is not.
	 */
	import { diffLines, type FileEdit } from '$lib/edits';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Spinner } from '$lib/components/ui/spinner';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let { edit, conversationId }: { edit: FileEdit; conversationId: string | null } = $props();

	let applying = $state(false);
	let applied = $state(false);
	let failure = $state<string | null>(null);

	const lines = $derived(diffLines(edit));

	async function apply() {
		if (!conversationId) {
			failure = 'Diese Unterhaltung ist noch nicht gespeichert.';
			return;
		}
		applying = true;
		failure = null;
		try {
			const res = await fetch('/api/files/edit', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					conversationId,
					filename: edit.filename,
					search: edit.search,
					replace: edit.replace
				})
			});
			if (res.ok) {
				applied = true;
			} else {
				const body = await res.json().catch(() => null);
				failure = body?.message ?? `Fehlgeschlagen (HTTP ${res.status})`;
			}
		} catch (e) {
			failure = `Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			applying = false;
		}
	}
</script>

<div class="bg-muted/40 overflow-hidden rounded-xl border">
	<div class="bg-muted/70 flex items-center gap-2 border-b px-3 py-1.5">
		<PencilIcon class="text-muted-foreground size-3.5 shrink-0" />
		<span class="truncate font-mono text-xs">{edit.filename}</span>
		<Badge variant="secondary" class="shrink-0 text-[0.65rem]">Änderung</Badge>
		<div class="ml-auto shrink-0">
			{#if applied}
				<span class="text-muted-foreground flex items-center gap-1 text-xs">
					<CheckIcon class="size-3.5" />
					Übernommen
				</span>
			{:else}
				<Button size="sm" variant="secondary" class="h-6" disabled={applying} onclick={apply}>
					{#if applying}<Spinner class="size-3" data-icon="inline-start" />{/if}
					Übernehmen
				</Button>
			{/if}
		</div>
	</div>

	<div class="max-h-56 overflow-auto font-mono text-xs leading-5">
		{#each lines as line, i (i)}
			<div
				class="px-3 whitespace-pre-wrap {line.sign === '-'
					? 'bg-destructive/10 text-destructive'
					: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'}"
			>{line.sign} {line.text}</div>
		{/each}
	</div>

	{#if failure}
		<p class="text-destructive flex items-start gap-1.5 border-t px-3 py-2 text-xs">
			<TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
			{failure}
		</p>
	{/if}
</div>
