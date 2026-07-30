/**
 * Copy text to the clipboard, on http:// too.
 *
 * `navigator.clipboard` is gated behind a secure context. chat.lab is served
 * over plain HTTP on the lab subnet (AGENTS.md §1), so the whole API is
 * `undefined` there -- not failing, not rejecting, simply absent. The copy
 * button read `await navigator.clipboard.writeText(...)`, which threw a
 * TypeError into a catch that quietly set `copied = false`: the button did
 * nothing at all, with no error to explain it. Same root cause as the inert
 * service worker (see vite.config.ts).
 *
 * The fallback is `document.execCommand('copy')`. It is deprecated, and it is
 * also the only thing that works here; every browser still supports it. It goes
 * away by itself the day the site is served over TLS, because the modern path
 * is tried first.
 */
export async function copyText(text: string): Promise<boolean> {
	// Preferred path: available on HTTPS and on localhost.
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Permission denied, or the document is not focused. Fall through.
		}
	}

	if (typeof document === 'undefined') return false;

	const carrier = document.createElement('textarea');
	carrier.value = text;
	// Off-screen rather than `display:none`: a hidden element cannot be selected,
	// and the selection is what execCommand copies. `readonly` keeps the mobile
	// keyboard from appearing.
	carrier.setAttribute('readonly', '');
	carrier.style.position = 'fixed';
	carrier.style.top = '-9999px';
	carrier.style.opacity = '0';
	document.body.appendChild(carrier);

	// Restore whatever the user had selected; copying should not steal it.
	const previous = document.getSelection()?.rangeCount
		? document.getSelection()!.getRangeAt(0)
		: null;

	try {
		carrier.select();
		carrier.setSelectionRange(0, carrier.value.length);
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		document.body.removeChild(carrier);
		if (previous) {
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(previous);
		}
	}
}
