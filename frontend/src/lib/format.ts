/** Tiered so a few hundred KB does not render as "0 MB". */
export function formatBytes(n: number): string {
	if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
	if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
	if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
	return `${n} B`;
}

export const formatDate = (iso: string) =>
	new Date(iso).toLocaleDateString('de-DE', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric'
	});
