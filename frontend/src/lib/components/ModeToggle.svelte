<script lang="ts">
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" aria-label="Design wechseln">
				<SunIcon
					class="size-[1.2rem] scale-100 rotate-0 !transition-all dark:scale-0 dark:-rotate-90"
				/>
				<MoonIcon
					class="absolute size-[1.2rem] scale-0 rotate-90 !transition-all dark:scale-100 dark:rotate-0"
				/>
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.Group>
			<DropdownMenu.Item
				onclick={() => setMode('light')}
				data-selected={userPrefersMode.current === 'light' ? '' : undefined}
			>
				<SunIcon />
				Hell
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onclick={() => setMode('dark')}
				data-selected={userPrefersMode.current === 'dark' ? '' : undefined}
			>
				<MoonIcon />
				Dunkel
			</DropdownMenu.Item>
			<DropdownMenu.Item
				onclick={() => setMode('system')}
				data-selected={userPrefersMode.current === 'system' ? '' : undefined}
			>
				<MonitorIcon />
				System
			</DropdownMenu.Item>
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>
