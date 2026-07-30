<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import TelescopeIcon from '@lucide/svelte/icons/telescope';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	let {
		value = $bindable<'fast' | 'deep'>('fast'),
		disabled = false
	}: { value?: 'fast' | 'deep'; disabled?: boolean } = $props();

	const MODES = [
		{
			id: 'fast' as const,
			label: 'Schnell',
			hint: 'Eine Suche · sofortige Antwort',
			icon: ZapIcon
		},
		{
			id: 'deep' as const,
			label: 'Gründlich',
			hint: 'Bis zu 3 Runden · mehrere Subagenten',
			icon: TelescopeIcon
		}
	];

	const current = $derived(MODES.find((m) => m.id === value) ?? MODES[0]);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger {disabled}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				class="text-muted-foreground hover:text-foreground gap-1 rounded-lg"
			>
				{current.label}
				<ChevronDownIcon data-icon="inline-end" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<!-- Opens upward: the composer sits at the bottom of the viewport. -->
	<DropdownMenu.Content side="top" align="end" sideOffset={8} class="w-64">
		<DropdownMenu.Group>
			{#each MODES as mode (mode.id)}
				{@const Icon = mode.icon}
				<DropdownMenu.Item class="items-start gap-3 py-2" onclick={() => (value = mode.id)}>
					<Icon class="mt-0.5" />
					<div class="flex min-w-0 flex-1 flex-col">
						<span class="font-medium">{mode.label}</span>
						<span class="text-muted-foreground text-xs">{mode.hint}</span>
					</div>
					{#if value === mode.id}
						<CheckIcon class="mt-0.5" />
					{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>
