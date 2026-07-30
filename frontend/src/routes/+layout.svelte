<script lang="ts">
	import '../app.css';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();
</script>

<!-- Applies the stored theme before paint, so there is no light-mode flash. -->
<ModeWatcher />

{@render children?.()}
