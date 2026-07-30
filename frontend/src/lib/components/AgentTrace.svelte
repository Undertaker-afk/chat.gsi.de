<script lang="ts">
	import type { AgentStep } from '$lib/chat.svelte';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Spinner } from '$lib/components/ui/spinner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import TelescopeIcon from '@lucide/svelte/icons/telescope';

	let { agents, running }: { agents: AgentStep[]; running: boolean } = $props();

	// Open while work is in flight -- watching subagents report is what makes a
	// 40-second wait feel purposeful rather than broken. Collapses once finished
	// so a completed answer is not buried under scaffolding.
	let open = $state(true);
	$effect(() => {
		if (!running) open = false;
	});

	const rounds = $derived.by(() => {
		const grouped = new Map<string, AgentStep[]>();
		for (const agent of agents) {
			const key = agent.id.split('-')[0];
			grouped.set(key, [...(grouped.get(key) ?? []), agent]);
		}
		return [...grouped.entries()];
	});

	const done = $derived(agents.filter((a) => a.state === 'done').length);
</script>

<Collapsible.Root bind:open class="bg-muted/40 rounded-lg border">
	<Collapsible.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="sm" class="w-full justify-start font-normal">
				<TelescopeIcon data-icon="inline-start" />
				Recherche
				<Badge variant="secondary" class="ml-1">{done}/{agents.length}</Badge>
				<ChevronDownIcon
					data-icon="inline-end"
					class="ml-auto transition-transform {open ? 'rotate-180' : ''}"
				/>
			</Button>
		{/snippet}
	</Collapsible.Trigger>

	<Collapsible.Content>
		<div class="flex flex-col gap-3 px-3 pt-1 pb-3">
			{#each rounds as [key, steps] (key)}
				<div class="flex flex-col gap-1.5">
					<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
						Runde {key.replace('r', '')}
					</p>
					<ul class="flex flex-col gap-1.5">
						{#each steps as step (step.id)}
							<li class="flex items-start gap-2 text-sm">
								<span class="mt-0.5 flex size-4 shrink-0 items-center justify-center">
									{#if step.state === 'running'}
										<Spinner class="size-3.5" />
									{:else if step.state === 'done'}
										<CheckIcon class="size-3.5 text-emerald-600 dark:text-emerald-500" />
									{:else}
										<XIcon class="text-destructive size-3.5" />
									{/if}
								</span>
								<span class="min-w-0 flex-1">
									<span class="text-foreground/90">{step.query}</span>
									{#if step.state === 'done' && step.findings !== undefined}
										<span class="text-muted-foreground">
											· {step.findings}
											{step.findings === 1 ? 'Quelle' : 'Quellen'}
										</span>
									{:else if step.state === 'failed'}
										<span class="text-destructive">· fehlgeschlagen</span>
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				</div>
			{/each}

		</div>
	</Collapsible.Content>
</Collapsible.Root>
