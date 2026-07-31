import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		/**
		 * PWA manifest + service worker.
		 *
		 * IMPORTANT: this does nothing at http://chat.lab today. Service workers
		 * are only available in a secure context -- HTTPS, or localhost. The lab
		 * subnet is deliberately plain HTTP (AGENTS.md §1), so the browser will
		 * decline to register the worker: no offline cache, no install prompt.
		 * Nothing else about the app is affected.
		 *
		 * It is wired up now so that the moment chat.gsi.de is served over TLS the
		 * PWA works with no code change. Do not debug a missing install prompt
		 * here -- check the URL scheme first.
		 */
		SvelteKitPWA({
			registerType: 'prompt',
			injectRegister: 'auto',
			manifest: {
				name: 'chat.gsi.de',
				short_name: 'chat.gsi',
				description: 'GSI-Dokumentationsassistent',
				lang: 'de',
				theme_color: '#0b0b0c',
				background_color: '#0b0b0c',
				display: 'standalone',
				start_url: '/',
				scope: '/',
				icons: [
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
					{
						src: '/icon-512-maskable.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			workbox: {
				// Monaco and pdf.js ship large chunks; the default 2 MiB cap would
				// silently drop exactly the assets an offline viewer would need.
				maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
				/**
				 * Shell only. `client/**` used to be precached wholesale, which after
				 * Shiki landed meant 353 entries / 13.4 MB -- every TextMate grammar,
				 * all of them lazily loaded and most never used. Precache is for what
				 * the app needs to start; on-demand chunks belong in runtime caching
				 * below, which stores a grammar the first time it is actually needed.
				 */
				globPatterns: [
					'client/*.{js,css,ico,png,svg,webp,woff,woff2}',
					'client/_app/immutable/entry/**/*.js',
					'client/_app/immutable/assets/**/*.css',
					'client/manifest.webmanifest'
				],
				runtimeCaching: [
					{
						urlPattern: /\/_app\/immutable\/.*\.(?:js|css|mjs)$/,
						handler: 'StaleWhileRevalidate',
						options: {
							cacheName: 'app-chunks',
							expiration: { maxEntries: 400, maxAgeSeconds: 30 * 24 * 60 * 60 }
						}
					}
				],
				// Never serve these from cache: answers, files and auth are all
				// per-session and must not outlive a logout.
				navigateFallbackDenylist: [/^\/api\//, /^\/auth\//, /^\/login/, /^\/logout/]
			},
			devOptions: { enabled: false }
		})
	],
	server: { host: '0.0.0.0', port: 3000, allowedHosts: ['chat.lab', 'keycloak.lab', '.lab'] }
});
