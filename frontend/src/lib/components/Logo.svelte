<script lang="ts">
	/**
	 * GSI wordmark, redrawn as SVG from the supplied favicon.ico.
	 *
	 * The .ico is 16x16 only, so scaling it into the header would be visibly
	 * pixellated. This traces the same letterforms so the mark stays sharp at any
	 * size. The letters use currentColor, so it inverts correctly in dark mode;
	 * the .ico itself is still the browser-tab favicon.
	 *
	 * Swap this for the official asset if a vector or high-res GSI logo exists.
	 */
	let { class: className = '' }: { class?: string } = $props();
</script>

<svg
	viewBox="0 0 47 24"
	role="img"
	aria-label="GSI"
	class={className}
	fill="none"
	xmlns="http://www.w3.org/2000/svg"
>
	<!-- Blocky GSI wordmark, matching the icon's geometry -->
	<g fill="currentColor">
		<!-- G -->
		<path d="M0 4h18v4H4v8h10v-3h-5V9h9v11H0V4z" fill-rule="evenodd" />
		<!-- S -->
		<path d="M21 4h18v4H25v2h14v10H21v-4h14v-2H21V4z" />
		<!-- I -->
		<rect x="42" y="4" width="5" height="16" />
	</g>
</svg>
