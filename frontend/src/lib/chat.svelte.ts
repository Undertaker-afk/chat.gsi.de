/** Client-side chat state: consumes the SSE stream from /api/chat. */

export interface Citation {
	marker: number;
	url: string;
	title: string;
	heading: string;
	/**
	 * Present only for sources outside the corpus. `read: false` means we had the
	 * metadata and never the document -- repository.gsi.de blocks automated file
	 * access -- and the chip says so rather than implying we read it.
	 */
	external?: {
		origin: 'indico' | 'repository' | 'corpus-link';
		read: boolean;
	};
}

export interface AgentStep {
	id: string;
	query: string;
	state: 'running' | 'done' | 'failed';
	findings?: number;
}

/** A generated file attached to a question. Metadata only; bytes on demand. */
export interface AttachedFile {
	id: string;
	filename: string;
	mime: string;
	language: string | null;
	bytes: number;
}

/** What the documents agent did, for the trace line. It runs on every turn. */
export interface DocumentStep {
	state: 'searching' | 'found' | 'none';
	/** Candidates the external searches returned, before triage. */
	searched?: number;
	/** How many were downloaded and read. */
	read?: number;
	sources?: {
		marker: number;
		origin: 'indico' | 'repository' | 'corpus-link';
		url: string;
		title: string;
		context: string;
		read: boolean;
	}[];
}

/** What the image subagent did, for the trace line. */
export interface ImageStep {
	state: 'searching' | 'found' | 'none';
	query: string;
	title?: string;
	credit?: string | null;
	url?: string;
	permalink?: string;
	candidates?: number;
	/** Present only when the search had to be broadened to return anything. */
	effectiveQuery?: string;
}

export interface ChatMessage {
	id?: string;
	parentId?: string | null;
	role: 'user' | 'assistant';
	content: string;
	/** Data URLs of attached images (both chat models are vision-capable). */
	images?: string[];
	/** Generated files this question carried, for the chips under it. */
	files?: AttachedFile[];
	citations: Citation[];
	agents: AgentStep[];
	/** Deep mode only, and only when the planner asked for a picture. */
	image?: ImageStep;
	/** Both modes, every turn. `state: 'none'` is the common case. */
	documents?: DocumentStep;
	/** Follow-up questions offered under the answer. May be empty. */
	suggestions?: string[];
	/** Position among sibling versions, for the "< 2/2 >" control. */
	version?: number;
	versions?: number;
	siblingIds?: string[];
	phase?: string;
	round?: number;
	partial?: boolean;
	streaming?: boolean;
	error?: string;
}

export interface ConversationSummary {
	id: string;
	title: string | null;
	mode: 'fast' | 'deep';
	updatedAt: string;
}

export class ChatSession {
	messages = $state<ChatMessage[]>([]);
	conversations = $state<ConversationSummary[]>([]);
	busy = $state(false);
	loading = $state(false);
	conversationId = $state<string | undefined>(undefined);
	mode = $state<'fast' | 'deep'>('fast');

	private controller: AbortController | null = null;

	// --- history ------------------------------------------------------------

	async loadConversations() {
		try {
			const res = await fetch('/api/conversations');
			if (res.ok) this.conversations = await res.json();
		} catch {
			// A failed history fetch must not break the chat itself.
		}
	}

	async open(id: string) {
		if (this.busy) return;
		this.loading = true;
		try {
			const res = await fetch(`/api/conversations/${id}`);
			if (!res.ok) return;
			const data = await res.json();
			this.conversationId = data.id;
			this.mode = data.mode ?? 'fast';
			this.messages = data.messages.map((m: ChatMessage) => ({
				...m,
				citations: m.citations ?? [],
				agents: m.agents ?? []
			}));
		} finally {
			this.loading = false;
		}
	}

	reset() {
		if (this.busy) this.stop();
		this.messages = [];
		this.conversationId = undefined;
	}

	async remove(id: string) {
		await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
		this.conversations = this.conversations.filter((c) => c.id !== id);
		if (this.conversationId === id) this.reset();
	}

	async rename(id: string, title: string) {
		await fetch(`/api/conversations/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title })
		});
		const entry = this.conversations.find((c) => c.id === id);
		if (entry) entry.title = title;
	}

	// --- versions -----------------------------------------------------------

	/** Jump to a sibling version of a message and re-render that branch. */
	async switchVersion(messageId: string) {
		if (!this.conversationId || this.busy) return;
		this.loading = true;
		try {
			const res = await fetch(`/api/conversations/${this.conversationId}/branch`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ messageId })
			});
			if (!res.ok) return;
			const data = await res.json();
			this.messages = data.messages.map((m: ChatMessage) => ({
				...m,
				citations: m.citations ?? [],
				agents: m.agents ?? []
			}));
		} finally {
			this.loading = false;
		}
	}

	/**
	 * Re-ask from an earlier point with edited text. The new turn becomes a
	 * SIBLING of the message being replaced, so the previous version stays
	 * reachable through the version control.
	 */
	async edit(message: ChatMessage, text: string) {
		if (this.busy || !text.trim()) return;
		const index = this.messages.findIndex((m) => m.id === message.id);
		if (index === -1) return;

		// Drop the edited message and everything after it from the view; the
		// server keeps them as the other branch.
		this.messages = this.messages.slice(0, index);
		await this.send(text, message.parentId ?? null);

		// Re-read the branch so the new turn immediately shows its "2/2" pager.
		// Locally-built messages carry no sibling data, so without this the version
		// control would not appear until the next reload.
		if (this.conversationId) await this.open(this.conversationId);
	}

	// --- sending ------------------------------------------------------------

	stop() {
		this.controller?.abort();
		this.controller = null;
		this.busy = false;
		const last = this.messages.at(-1);
		if (last?.streaming) {
			last.streaming = false;
			last.partial = true;
		}
	}

	/**
	 * `files` are whole generated-file records rather than ids: the server needs
	 * only the ids, but the optimistic user message needs the names to draw its
	 * chips before any round trip.
	 */
	async send(
		question: string,
		parentId?: string | null,
		images?: string[],
		files?: AttachedFile[]
	) {
		if (!question.trim() || this.busy) return;
		const isNew = !this.conversationId;

		this.messages.push({
			role: 'user',
			content: question,
			images,
			files,
			citations: [],
			agents: []
		});
		this.messages.push({
			role: 'assistant',
			content: '',
			citations: [],
			agents: [],
			streaming: true
		});

		// Read the elements BACK out of the $state array. Svelte 5 stores the raw
		// object and hands out a proxy on read; mutating the objects we pushed would
		// bypass the proxy's setter, so no reactivity fires and the answer only
		// appears once something else happens to repaint. That is what made
		// streaming look broken even though the SSE tokens were arriving fine.
		const asked = this.messages[this.messages.length - 2];
		const reply = this.messages[this.messages.length - 1];

		this.busy = true;
		this.controller = new AbortController();

		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					question,
					mode: this.mode,
					conversationId: this.conversationId,
					...(images?.length ? { images } : {}),
					...(files?.length ? { files: files.map((f) => f.id) } : {}),
					...(parentId !== undefined ? { parentId } : {})
				}),
				signal: this.controller.signal
			});
			if (!res.ok || !res.body) throw new Error(`request failed: ${res.status}`);

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				// A frame can span reads; keep the trailing partial in the buffer.
				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';
				for (const frame of frames) this.#handle(frame, asked, reply);
			}
		} catch (err) {
			if ((err as Error).name !== 'AbortError') {
				reply.error = err instanceof Error ? err.message : 'stream failed';
			}
		} finally {
			reply.streaming = false;
			this.busy = false;
			this.controller = null;
			// Refresh history so a new or renamed conversation appears in the sidebar.
			if (isNew || parentId !== undefined) await this.loadConversations();
		}
	}

	#handle(frame: string, asked: ChatMessage, reply: ChatMessage) {
		const line = frame.split('\n').find((l) => l.startsWith('data:'));
		if (!line) return;

		let event: any;
		try {
			event = JSON.parse(line.slice(5).trim());
		} catch {
			return;
		}

		switch (event.type) {
			case 'conversation':
				this.conversationId = event.id;
				asked.id = event.userMessageId;
				asked.parentId = event.parentId;
				break;
			case 'status':
				reply.phase = event.phase;
				reply.round = event.round;
				break;
			case 'agent': {
				const existing = reply.agents.find((a) => a.id === event.id);
				if (existing) Object.assign(existing, event);
				else reply.agents.push({ ...event });
				break;
			}
			case 'image':
				// One image per answer, so this replaces rather than accumulates.
				reply.image = { ...event };
				break;
			case 'documents':
				// Same: one documents pass per answer, and the later event carries
				// the final state.
				reply.documents = { ...event };
				break;
			case 'token':
				reply.content += event.text;
				break;
			case 'citation':
				reply.citations.push(event);
				break;
			case 'suggestions':
				reply.suggestions = event.items;
				break;
			case 'saved':
				reply.id = event.messageId;
				break;
			case 'title': {
				const entry = this.conversations.find((c) => c.id === this.conversationId);
				if (entry) entry.title = event.title;
				break;
			}
			case 'done':
				reply.partial = event.partial;
				reply.phase = undefined;
				break;
			case 'error':
				reply.error = event.message;
				break;
		}
	}
}
