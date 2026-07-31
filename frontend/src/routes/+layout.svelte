<script lang="ts">
	import '../app.css';
	import { ModeWatcher } from 'mode-watcher';
	import { setLanguage } from '$lib/language.svelte';

	let { children, data } = $props();

	// Sync the language store from the user's saved preference. Done in an effect
	// (client-only) rather than at module load so the module state is never
	// mutated during SSR -- that state is shared across requests on the server,
	// so writing it there would leak one user's language to another. The first
	// client render matches the SSR default, then this corrects it.
	$effect(() => {
		if (data?.language) setLanguage(data.language);
	});
</script>

<!-- Applies the stored theme before paint, so there is no light-mode flash. -->
<ModeWatcher />

{@render children?.()}
