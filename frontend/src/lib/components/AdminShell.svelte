<script lang="ts">
	/**
	 * Shared chrome for /admin and /management: the sketch's left action list and
	 * right work area, with a back link to the chat. Kept as one component so the
	 * two pages cannot drift apart visually.
	 */
	import { t } from '$lib/language.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import Logo from './Logo.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import type { Component, Snippet } from 'svelte';

	interface Section {
		id: string;
		label: string;
		icon: Component<{ class?: string }>;
		description?: string;
	}

	let {
		title,
		subtitle,
		sections,
		active = $bindable(sections[0]?.id),
		children,
		footer,
		collapsibleSections = false
	}: {
		title: string;
		subtitle?: string;
		sections: Section[];
		active?: string;
		children: Snippet;
		footer?: Snippet;
		/**
		 * Let the section rail collapse to icons. Opt-in, because /admin and
		 * /management use the rail as their primary navigation and have nothing to
		 * gain from the extra width, whereas /files puts a viewer beside it.
		 */
		collapsibleSections?: boolean;
	} = $props();

	let railOpen = $state(true);
</script>

<div class="bg-background text-foreground min-h-svh">
	<header class="flex items-center gap-3 border-b px-4 py-3">
		<Button variant="ghost" size="icon" href="/" aria-label={t('adminShell.backToChat')}>
			<ArrowLeftIcon />
		</Button>
		<Logo class="h-5 w-auto" />
		<Separator orientation="vertical" class="mx-1 h-5" />
		<div class="flex min-w-0 flex-col">
			<h1 class="truncate text-sm font-medium">{title}</h1>
			{#if subtitle}
				<p class="text-muted-foreground truncate text-xs">{subtitle}</p>
			{/if}
		</div>
	</header>

	<div class="mx-auto flex w-full max-w-[110rem] gap-6 p-4 md:p-6">
		<!-- Action list -->
		<nav
			class="hidden shrink-0 flex-col gap-1 transition-[width] md:flex {collapsibleSections &&
			!railOpen
				? 'w-12'
				: 'w-56'}"
		>
			{#if collapsibleSections}
				<!-- Toggle sits at the head of the list it controls, aligned with the
				     rows below it -- not floated to an edge, where it read as belonging
				     to the page rather than to the rail. -->
				<div
					class="mb-1 flex h-8 items-center gap-2 {railOpen
						? 'justify-between px-3'
						: 'justify-center'}"
				>
					{#if railOpen}
						<span class="text-muted-foreground text-xs font-medium">{t('adminShell.categories')}</span>
					{/if}
					<Button
						variant="ghost"
						size="icon"
						class="size-7 shrink-0"
						aria-label={railOpen ? t('adminShell.collapseCategories') : t('adminShell.expandCategories')}
						onclick={() => (railOpen = !railOpen)}
					>
						{#if railOpen}<PanelLeftCloseIcon />{:else}<PanelLeftOpenIcon />{/if}
					</Button>
				</div>
			{/if}
			{#each sections as section (section.id)}
				{@const Icon = section.icon}
				{@const collapsed = collapsibleSections && !railOpen}
				<button
					type="button"
					title={collapsed ? section.label : undefined}
					class="hover:bg-muted flex items-start gap-2.5 rounded-lg py-2 text-left text-sm transition-colors
						{collapsed ? 'justify-center px-0' : 'px-3'}
						{active === section.id ? 'bg-muted font-medium' : 'text-muted-foreground'}"
					onclick={() => (active = section.id)}
				>
					<Icon class="mt-0.5 size-4 shrink-0" />
					{#if !collapsed}
						<span class="flex flex-col gap-0.5">
							{section.label}
							{#if section.description}
								<span class="text-muted-foreground text-xs font-normal">{section.description}</span>
							{/if}
						</span>
					{/if}
				</button>
			{/each}
		</nav>

		<!-- Actions -->
		<main class="flex min-w-0 flex-1 flex-col gap-4">
			<!-- Small screens get the section list as a scrollable row instead. -->
			<div class="flex gap-1 overflow-x-auto md:hidden">
				{#each sections as section (section.id)}
					<Button
						variant={active === section.id ? 'secondary' : 'ghost'}
						size="sm"
						class="shrink-0"
						onclick={() => (active = section.id)}
					>
						{section.label}
					</Button>
				{/each}
			</div>

			{@render children()}
		</main>
	</div>

	{#if footer}
		<div class="mx-auto w-full max-w-[110rem] px-4 pb-6 md:px-6">
			{@render footer()}
		</div>
	{/if}
</div>
