/** SSE chat endpoint. Streams orchestrator events to the browser (plan.md §7). */
import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { run } from '$lib/server/orchestrator/lead';
import type { Mode, OrchestratorEvent } from '$lib/server/orchestrator/types';
import { complete, parseJson, type Message } from '$lib/server/llm';
import { FOLLOWUP_SYSTEM } from '$lib/server/orchestrator/prompts';
import { config } from '$lib/server/config';
import {
	addCitations,
	addMessage,
	createConversation,
	getConversation,
	renameConversation,
	setActiveLeaf
} from '$lib/server/db';
import { conversationPath } from '$lib/server/tree';
import { asDataUrls, asDocumentTexts, isAttachmentId, linkToMessage } from '$lib/server/uploads';
import { quotaMessage, usage } from '$lib/server/storage';
import { effectiveKbIds } from '$lib/server/permissions';
import {
	linkAttachedFiles,
	listGeneratedInConversation,
	readGenerated
} from '$lib/server/generated';

interface Body {
	question: string;
	mode: Mode;
	conversationId?: string;
	/**
	 * Branch point. When editing an earlier message the client sends the PARENT of
	 * the message being replaced, so the new turn becomes a sibling of it rather
	 * than overwriting it. Omitted for a normal turn (append to the active leaf).
	 */
	parentId?: string | null;
	images?: string[];
	/** Generated-file ids attached from the composer's "Generiert" menu. */
	files?: string[];
}

/** Guard on how much attached file text may ride along with one question. */
const MAX_ATTACHED_FILE_CHARS = 60_000;

export const POST: RequestHandler = async ({ request, locals }) => {
	const user = locals.user;
	if (!user) error(401, 'unauthenticated');

	const body = (await request.json()) as Body;
	const question = (body.question ?? '').trim();
	if (!question) error(400, 'question is required');

	const mode: Mode = body.mode === 'deep' ? 'deep' : 'fast';

	// Conversation text counts against the same quota as uploads, so a full
	// account cannot keep writing. Checked before the turn starts rather than
	// mid-stream, where the user would lose the answer they were already reading.
	const storage = await usage(user.sub);
	if (storage.used >= storage.quota) error(413, quotaMessage(storage));

	// getConversation is scoped by user_sub, so a forged id cannot reach another
	// user's conversation -- it falls through to creating a new one.
	let conversation = body.conversationId
		? await getConversation(body.conversationId, user.sub)
		: null;
	const isNew = !conversation;
	const conversationId = conversation?.id ?? (await createConversation(user.sub, mode, null));

	// History is the branch currently on screen, not every message ever sent.
	const existing = conversation
		? await conversationPath(conversationId, conversation.active_leaf_id)
		: [];

	let parentId: string | null;
	if (body.parentId !== undefined) {
		parentId = body.parentId; // explicit branch point (edit)
	} else {
		parentId = existing.at(-1)?.id ?? null;
	}

	// When branching, the model must only see the turns ABOVE the branch point.
	const cutoff = parentId ? existing.findIndex((m) => m.id === parentId) : -1;
	const visible = parentId ? existing.slice(0, cutoff + 1) : existing;
	const history: Message[] = visible.map((m) => ({
		role: m.role as Message['role'],
		content: m.content
	}));

	// Knowledge bases this user may search. Resolved per request rather than
	// cached in the session, so a revocation takes effect on the next question
	// instead of at the next login.
	const kbIds = await effectiveKbIds(user.sub);

	// Uploads are referenced by id; the bytes stay server-side. The model needs
	// them inline, so they are expanded to data URLs only for that call.
	const attachmentIds = (body.images ?? []).filter(isAttachmentId);
	const imageDataUrls = await asDataUrls(attachmentIds, user.sub);

	// What the assistant is allowed to rewrite this turn. Scoped to the
	// conversation, so a file kept in another chat is neither offered nor
	// reachable -- see EDIT_ADDENDUM and /api/files/edit.
	const generatedFiles = conversation
		? (await listGeneratedInConversation(user.sub, conversationId)).map((f) => ({
				filename: f.filename,
				bytes: f.bytes
			}))
		: [];

	// Files the user attached this turn. readGenerated is scoped by user_sub, so
	// an id belonging to somebody else simply resolves to nothing.
	const attachedFiles: { filename: string; content: string }[] = [];
	let attachedChars = 0;
	for (const id of (body.files ?? []).slice(0, 5)) {
		if (typeof id !== 'string') continue;
		const found = await readGenerated(user.sub, id);
		if (!found) continue;
		// Truncated rather than dropped: half a job script still tells the model
		// what the user is asking about, and the cut is marked so it cannot be
		// mistaken for the whole file.
		const room = MAX_ATTACHED_FILE_CHARS - attachedChars;
		if (room <= 0) break;
		const content =
			found.content.length > room ? `${found.content.slice(0, room)}\n… (gekürzt)` : found.content;
		attachedChars += content.length;
		attachedFiles.push({ filename: found.file.filename, content });
	}

	// Uploaded documents -- a PDF, a slide deck, a spreadsheet -- become text the
	// same way an Indico attachment does, and then join the same list as generated
	// files. They are NOT sent as image parts: a vision model handed
	// `data:application/pdf;base64,...` reads nothing, which is what made an
	// uploaded PDF a file you could only re-open rather than ask about.
	for (const document of await asDocumentTexts(attachmentIds, user.sub)) {
		const room = MAX_ATTACHED_FILE_CHARS - attachedChars;
		if (room <= 0) break;
		const content =
			document.content.length > room
				? `${document.content.slice(0, room)}\n… (gekürzt)`
				: document.content;
		attachedChars += content.length;
		attachedFiles.push({ filename: document.filename, content });
	}

	const userMessageId = await addMessage({
		conversationId,
		role: 'user',
		content: question,
		images: attachmentIds.length ? attachmentIds.map((id) => `/api/uploads/${id}`) : null,
		parentId
	});
	await linkToMessage(attachmentIds, user.sub, userMessageId);
	// Recorded so the question keeps showing what it carried. Without this the
	// transcript reads as a bare question and the file is unreachable from it.
	await linkAttachedFiles(
		userMessageId,
		user.sub,
		attachedFiles.length ? (body.files ?? []).filter((f): f is string => typeof f === 'string') : []
	);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (event: { type: string; [k: string]: unknown }) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
					);
				} catch {
					closed = true; // client went away mid-stream
				}
			};

			send({
				type: 'conversation',
				id: conversationId,
				userMessageId,
				parentId
			});

			let answer = '';
			const citations: Extract<OrchestratorEvent, { type: 'citation' }>[] = [];
			const trace: OrchestratorEvent[] = [];

			try {
				for await (const event of run({
					question,
					history,
					mode,
					images: imageDataUrls,
					kbIds,
					generatedFiles,
					attachedFiles
				})) {
					if (event.type === 'token') answer += event.text;
					if (event.type === 'citation') citations.push(event);
					if (
						event.type === 'agent' ||
						event.type === 'status' ||
						event.type === 'image' ||
						event.type === 'documents'
					) {
						trace.push(event);
					}
					send(event);
				}

				// Generated before the message is written so the suggestions land in
				// the same trace, rather than needing a second write to attach them.
				// The answer is already fully on screen by now; this only delays the
				// `saved` event, and never runs long enough to matter.
				const suggestions = answer ? await suggestFollowUps(question, answer) : [];
				if (suggestions.length) {
					trace.push({ type: 'suggestions', items: suggestions } as never);
					send({ type: 'suggestions', items: suggestions });
				}

				// Persist after streaming, so a disconnected client still leaves a
				// complete record behind.
				const messageId = await addMessage({
					conversationId,
					role: 'assistant',
					content: answer,
					parentId: userMessageId,
					trace: { mode, events: trace }
				});
				// Chunk citations only. `citations.chunk_id` is a foreign key into
				// `chunks`, and an external source has no chunk to point at -- it is
				// a PDF on indico.gsi.de, not something we indexed. Those are
				// restored from the `documents` trace event instead, which is the
				// same route the chosen image already takes.
				await addCitations(
					messageId,
					citations
						.filter((c): c is typeof c & { chunkId: number } => c.chunkId !== undefined)
						.map((c) => ({
							marker: c.marker,
							chunkId: c.chunkId,
							score: c.score
						}))
				);
				await setActiveLeaf(conversationId, messageId);
				send({ type: 'saved', messageId });

				// Name the conversation from the first exchange. Done after the answer
				// so it never delays time-to-first-token.
				if (isNew && answer) {
					const title = await suggestTitle(question, answer);
					if (title) {
						await renameConversation(conversationId, user.sub, title);
						send({ type: 'title', title });
					}
				}
			} catch (err) {
				send({
					type: 'error',
					message: err instanceof Error ? err.message : 'stream failed'
				});
			} finally {
				if (!closed) controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};

/**
 * Up to three follow-up questions to offer under the answer.
 *
 * Never throws: a suggestion strip is decoration, and losing it must not cost
 * the user the answer it sits beneath.
 */
async function suggestFollowUps(question: string, answer: string): Promise<string[]> {
	try {
		const raw = await complete(
			[
				{ role: 'system', content: FOLLOWUP_SYSTEM },
				// The answer is truncated because only its subject matter is needed to
				// propose a next step, and this runs on the small model.
				{ role: 'user', content: `Question: ${question}\n\nAnswer:\n${answer.slice(0, 1500)}` }
			],
			// 500, not 200: at 200 the reply is cut off mid-JSON ("{\"suggestions"),
			// parseJson returns null and the strip silently never appears. Measured
			// 2026-07-29 -- German fitted, English did not, so the bug looked like
			// "no suggestions in English". Generation stops at the closing brace, so
			// the higher ceiling costs nothing in latency.
			{ model: config.llm.utilityModel, maxTokens: 500, temperature: 0.4, json: true }
		);

		const parsed = parseJson<{ suggestions: string[] }>(raw);
		const seen = new Set<string>();
		return (parsed?.suggestions ?? [])
			.filter((s): s is string => typeof s === 'string')
			.map((s) => s.trim().replace(/^[-•*]\s*/, ''))
			// Length-capped rather than truncated: an over-long suggestion is a sign
			// the model wrote a sentence, and a clipped sentence reads like a bug.
			.filter((s) => s.length >= 3 && s.length <= 60)
			.filter((s) => {
				const key = s.toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.slice(0, 3);
	} catch {
		return [];
	}
}

/** Short, descriptive conversation name from the first exchange. */
async function suggestTitle(question: string, answer: string): Promise<string | null> {
	try {
		const raw = await complete(
			[
				{
					role: 'system',
					content:
						'Give this conversation a title of at most 6 words, in the language of the ' +
						'question. Name the concrete topic — "Linux-Passwort zurücksetzen", not ' +
						'"Frage zu Linux". Reply with the title only: no quotes, no punctuation at ' +
						'the end, no preamble.'
				},
				{
					role: 'user',
					content: `Q: ${question}\n\nA: ${answer.slice(0, 600)}`
				}
			],
			{ model: config.llm.utilityModel, maxTokens: 400, temperature: 0.3 }
		);

		// Utility models sometimes wrap the answer in quotes or add a label.
		const title = raw
			.trim()
			.split('\n')
			.filter((l) => l.trim())
			.at(-1)!
			.replace(/^["'«»„“]+|["'«»„“.]+$/g, '')
			.replace(/^(titel|title)\s*:\s*/i, '')
			.trim();

		return title.length >= 2 && title.length <= 120 ? title : null;
	} catch {
		return null; // a nameless conversation is fine; a failed request is not
	}
}
