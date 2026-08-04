/**
 * The lead agent. Two modes (plan.md §7):
 *
 *   gsi-fast — one agent, one round: rewrite -> retrieve -> answer.
 *   gsi-deep — up to 3 rounds of up to 4 parallel subagents, then synthesis.
 *
 * The critical constraint is the 200000-token context window. The lead NEVER sees
 * raw chunks from subagents, only their findings; a 4-way fan-out of 12 chunks
 * each would overflow the window by round two. Chunk text reaches the model in
 * exactly two places: inside a subagent, and in fast mode's single context.
 */
import { config } from '../config';
import { complete, parseJson, stream, type Message } from '../llm';
import { formatContext, retrieve } from '../retrieval';
import {
	ANSWER_SYSTEM,
	DOCS_RESULT_ADDENDUM,
	EDIT_ADDENDUM,
	GAP_SYSTEM,
	IMAGE_ADDENDUM,
	IMAGE_RESULT_ADDENDUM,
	PLANNER_SYSTEM,
	SUBAGENT_SYSTEM,
	fill
} from './prompts';
import { runSubagent } from './subagent';
import { runImageAgent, type ChosenImage } from './imageagent';
import { runDocumentsAgent, type DocumentFindings, type DocumentSource } from './docsagent';
import { CitationPool, type Finding, type Mode, type OrchestratorEvent } from './types';
import { metrics } from '../metrics';

export interface RunInput {
	question: string;
	history: Message[];
	mode: Mode;
	images?: string[];
	/** Knowledge bases the asking user may search. Undefined = unrestricted. */
	kbIds?: number[];
	/**
	 * Files saved from THIS conversation. Names only -- the contents were written
	 * by the model a few turns ago and are already in `history`, so repeating them
	 * would spend context on text the model can see anyway.
	 */
	generatedFiles?: { filename: string; bytes: number }[];
	/**
	 * Generated files the user attached to this question. Contents, unlike
	 * `generatedFiles`: the point is that the model can read a file it may not
	 * have written in this conversation.
	 */
	attachedFiles?: { filename: string; content: string }[];
}

export async function* run(input: RunInput): AsyncGenerator<OrchestratorEvent> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.orchestrator.wallClockBudgetMs);

	const pool = new CitationPool();
	let rounds = 0;
	let subagents = 0;
	let partial = false;
	let outcome = 'ok';

	// Resolved with the document ids the corpus retrieval matched, so the
	// documents agent can look at what those pages LINK to. Deferred rather than
	// awaited because the agent's web searches do not depend on it: this way the
	// agent starts now and the corpus ids arrive while it is already working.
	let resolveCorpusIds: (ids: number[]) => void = () => {};
	const corpusIds = new Promise<number[]>((resolve) => {
		resolveCorpusIds = resolve;
	});

	// Always. Not gated on a planner, not gated on mode -- see docsagent.ts for
	// why. Started before any corpus work and awaited just before the answer is
	// written, so it is off the critical path; never allowed to reject, so it can
	// only ever add to an answer.
	//
	// The RAW question, not the standalone rewrite: the rewrite is a model call we
	// would otherwise have to wait for before starting, and these are keyword
	// searches against external indexes where a follow-up's missing antecedent
	// costs far less than the delay would.
	//
	// Only started in deep mode. Fast mode does a single retrieval pass and the
	// external search adds latency without the sub-agent fan-out to hide it.
	let documentWork: Promise<DocumentFindings | null> = Promise.resolve(null);

	/** External sources, in the order they will be cited. Filled just before the answer. */
	let externalSources: DocumentSource[] = [];

	try {
		const question = await standalone(input, controller.signal);


		if (input.mode === 'fast') {
			rounds = 1;
			yield { type: 'status', phase: 'retrieving', round: 1 };
			const chunks = await retrieve(question, {
				limit: config.orchestrator.contextChunksFast,
				signal: controller.signal,
				kbIds: input.kbIds
			});
			chunks.forEach((chunk) => pool.add(chunk));
			resolveCorpusIds([...new Set(chunks.map((c) => c.documentId))]);

			const documents = await documentWork;
			externalSources = documents?.sources ?? [];
			yield* documentEvents(documents, pool.size);
			yield* answer(
				`Question: ${input.question}\n\nSources:\n\n${formatContext(chunks)}` +
					externalContext(documents, pool.size),
				input,
				controller.signal,
				null,
				documents,
				pool.size
			);
		} else {
			// Start the documents agent alongside the planner so its external
			// searches overlap with the first retrieval round.
			documentWork = runDocumentsAgent(input.question, corpusIds, controller.signal).catch(
				() => null
			);
			const findings: Finding[] = [];
			const { subqueries, imageQuery } = await plan(question, controller.signal);
			let queries = subqueries;

			// Started here and awaited just before synthesis: the media search plus a
			// vision call takes about as long as one research round, so running it
			// alongside them costs no extra wall-clock. Never awaited eagerly, and
			// never allowed to reject -- an answer without a picture is fine, an
			// answer that failed because of a picture is not.
			const imageWork = imageQuery
				? runImageAgent(imageQuery, controller.signal).catch(() => null)
				: null;
			if (imageQuery) {
				yield { type: 'image', state: 'searching', query: imageQuery };
			}
			yield { type: 'documents', state: 'searching' };

			while (rounds < config.orchestrator.maxRounds && queries.length > 0) {
				rounds += 1;
				yield { type: 'status', phase: 'retrieving', round: rounds };

				const batch = queries.slice(0, config.orchestrator.maxSubagentsPerRound);
				for (const [i, query] of batch.entries()) {
					yield { type: 'agent', id: `r${rounds}-s${i + 1}`, query, state: 'running' };
				}

				const results = await Promise.allSettled(
					batch.map((query, i) =>
						runSubagent(
							`r${rounds}-s${i + 1}`,
							query,
							pool,
							SUBAGENT_SYSTEM,
							controller.signal,
							input.kbIds
						)
					)
				);
				subagents += batch.length;

				for (const [i, result] of results.entries()) {
					const id = `r${rounds}-s${i + 1}`;
					if (result.status === 'fulfilled') {
						findings.push(result.value);
						yield {
							type: 'agent',
							id,
							query: batch[i],
							state: 'done',
							findings: result.value.markers.length
						};
					} else {
						yield { type: 'agent', id, query: batch[i], state: 'failed' };
					}
				}

				// After round one the pool holds the documents the corpus matched, so
				// the linked-PDF search can start. Resolving a settled promise again is
				// a no-op, which is what makes it safe to do this inside the loop.
				resolveCorpusIds([...new Set(pool.entries.map((c) => c.documentId))]);

				if (rounds >= config.orchestrator.maxRounds || findings.length === 0) break;

				yield { type: 'status', phase: 'reading', round: rounds };
				const gaps = await assessGaps(question, findings, controller.signal);
				if (gaps.length === 0) break;
				queries = gaps;
			}

			const image = imageWork ? await imageWork : null;
			if (imageQuery) {
				yield image
					? {
							type: 'image',
							state: 'found',
							query: imageQuery,
							title: image.record.title,
							credit: image.record.copyright,
							url: image.url,
							permalink: image.record.permalink,
							candidates: image.candidates,
							// Shown only when it differs, so a broadened search is never
							// silent -- the reason a picture is less specific than asked.
							effectiveQuery:
								image.effectiveQuery === imageQuery ? undefined : image.effectiveQuery
						}
					: { type: 'image', state: 'none', query: imageQuery };
			}

			// The loop can exit before the resolve above ever runs (zero findings on
			// round one). Settling it here means the agent is never left waiting on
			// a promise nobody will keep.
			resolveCorpusIds([...new Set(pool.entries.map((c) => c.documentId))]);

			const documents = await documentWork;
			externalSources = documents?.sources ?? [];
			yield* documentEvents(documents, pool.size);

			yield { type: 'status', phase: 'writing', round: rounds };
			yield* answer(
				synthesisPrompt(input.question, findings, pool) + externalContext(documents, pool.size),
				input,
				controller.signal,
				image,
				documents,
				pool.size
			);
		}

		// Citations are emitted after the answer: only now is the pool final, and
		// the client resolves [n] markers against it once the text is complete.
		for (const [index, chunk] of pool.entries.entries()) {
			yield {
				type: 'citation',
				marker: index + 1,
				chunkId: chunk.chunkId,
				url: chunk.url + (chunk.anchor ?? ''),
				title: chunk.title,
				heading: chunk.headingPath.join(' › '),
				score: chunk.score,
				fetchedAt: chunk.fetchedAt?.toISOString?.() ?? String(chunk.fetchedAt ?? '')
			};
		}

		// External sources continue the same numbering, so the reader gets one
		// source list rather than two competing ones. They carry `external` instead
		// of `chunkId`: the client needs to badge them differently, and "read the
		// document" versus "read only the abstract" is a distinction that has to
		// survive all the way to the screen.
		for (const [index, source] of externalSources.entries()) {
			yield {
				type: 'citation',
				marker: pool.size + index + 1,
				url: source.url,
				title: source.title,
				heading: source.context,
				score: 0,
				fetchedAt: source.date ?? '',
				external: { origin: source.origin, read: source.read }
			};
		}


	} catch (error) {
		partial = true;
		const aborted = controller.signal.aborted;
		outcome = aborted ? 'budget_exhausted' : 'error';
		if (aborted) metrics.orchestratorBudgetExhausted.inc();
		yield {
			type: 'error',
			message: aborted
				? 'The request exceeded its time budget. Showing what was gathered so far.'
				: error instanceof Error
					? error.message
					: 'Unknown error'
		};
	} finally {
		clearTimeout(timer);
		// In `finally` because a generator can be abandoned: if the browser
		// disconnects mid-answer the consumer calls return() on us and we never
		// reach the `done` event below. Those turns are real work and real proxy
		// cost, and leaving them uncounted would make the turn rate quietly
		// understate load whenever people give up on slow answers. (An abandoned
		// turn is indistinguishable from a completed one here, so it lands under
		// outcome="ok"; chatgsi_llm_requests_total{outcome="aborted"} is where a
		// wave of give-ups actually shows up.)
		metrics.chatTurns.inc({ mode: input.mode, outcome });
		metrics.chatTurnDuration.observe({ mode: input.mode }, (Date.now() - started) / 1000);
		metrics.orchestratorRounds.observe({ mode: input.mode }, rounds);
		if (subagents) metrics.orchestratorSubagents.inc({ mode: input.mode }, subagents);
	}

	yield {
		type: 'done',
		usage: { rounds, subagents, chunks: pool.size, elapsedMs: Date.now() - started },
		partial
	};
}

/**
 * Trace events for the documents agent.
 *
 * `none` is emitted rather than nothing at all. The agent runs on every turn, so
 * silence would be ambiguous between "it found nothing" and "it never ran", and
 * only one of those is worth investigating.
 */
function* documentEvents(
	documents: DocumentFindings | null,
	offset: number
): Generator<OrchestratorEvent> {
	if (!documents || documents.sources.length === 0) {
		yield { type: 'documents', state: 'none', searched: documents?.searched ?? 0, read: 0 };
		return;
	}
	yield {
		type: 'documents',
		state: 'found',
		searched: documents.searched,
		read: documents.read,
		sources: documents.sources.map((s, i) => ({
			marker: offset + i + 1,
			origin: s.origin,
			url: s.url,
			title: s.title,
			context: s.context,
			read: s.read
		}))
	};
}

/**
 * The external findings, appended to whatever context the mode already built.
 *
 * Markers are renumbered from `offset` so they continue the corpus numbering the
 * model has already been given. The agent numbered its own summary [1], [2] from
 * one, and handing the lead two independent [1]s would produce an answer whose
 * citations point at the wrong sources -- silently, since both numbers resolve.
 */
function externalContext(documents: DocumentFindings | null, offset: number): string {
	if (!documents?.summary || documents.sources.length === 0) return '';

	const renumbered = documents.summary.replace(/\[(\d+)\]/g, (whole, n) => {
		const local = Number(n);
		return local >= 1 && local <= documents.sources.length ? `[${offset + local}]` : whole;
	});

	const listing = documents.sources
		.map(
			(s, i) =>
				`[${offset + i + 1}] ${s.title}${s.context ? ` — ${s.context}` : ''}` +
				`${s.read ? '' : ' (nur Metadaten / metadata only)'}`
		)
		.join('\n');

	return `\n\n---\n\nExternal sources (Indico / repository / linked PDFs):\n\n${renumbered}\n\n${listing}`;
}

/** Rewrite a conversational follow-up into a standalone query.
 *  Skipped on the first turn, where there is nothing to resolve against. */
async function standalone(input: RunInput, signal: AbortSignal): Promise<string> {
	if (input.history.length === 0) return input.question;

	const recent = input.history
		.slice(-4)
		.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[image]'}`)
		.join('\n');

	try {
		const rewritten = await complete(
			[
				{
					role: 'system',
					content:
						'Rewrite the final user message as a standalone search query that makes sense ' +
						'without the conversation. Resolve pronouns and implicit references. ' +
						'Return only the query, no preamble.'
				},
				{ role: 'user', content: `${recent}\nuser: ${input.question}` }
			],
			{ model: config.llm.utilityModel, maxTokens: 120, temperature: 0, signal }
		);
		return rewritten.trim() || input.question;
	} catch {
		return input.question;
	}
}

async function plan(
	question: string,
	signal: AbortSignal
): Promise<{ subqueries: string[]; imageQuery: string | null }> {
	try {
		const raw = await complete(
			[
				{
					role: 'system',
					content: fill(PLANNER_SYSTEM, {
						maxSubagents: config.orchestrator.maxSubagentsPerRound
					})
				},
				{ role: 'user', content: question }
			],
			{ maxTokens: 400, temperature: 0.2, json: true, signal }
		);
		const parsed = parseJson<{ subqueries: string[]; image_query: string | null }>(raw);
		const queries = (parsed?.subqueries ?? [])
			.filter((q) => typeof q === 'string' && q.trim())
			.slice(0, config.orchestrator.maxSubagentsPerRound);

		const raw_image = parsed?.image_query;
		// A model that ignores `null` tends to write "null" or "" instead, and both
		// would search the library for nothing.
		const imageQuery =
			typeof raw_image === 'string' && raw_image.trim() && raw_image.trim().toLowerCase() !== 'null'
				? raw_image.trim().slice(0, 120)
				: null;

		return { subqueries: queries.length ? queries : [question], imageQuery };
	} catch {
		return { subqueries: [question], imageQuery: null };
	}
}

async function assessGaps(
	question: string,
	findings: Finding[],
	signal: AbortSignal
): Promise<string[]> {
	try {
		const raw = await complete(
			[
				{
					role: 'system',
					content: fill(GAP_SYSTEM, { maxSubagents: config.orchestrator.maxSubagentsPerRound })
				},
				{
					role: 'user',
					content: `Question: ${question}\n\nFindings so far:\n${findings
						.map((f) => `- (${f.confidence}) ${f.query}: ${f.summary}`)
						.join('\n')}`
				}
			],
			{ maxTokens: 400, temperature: 0.2, json: true, signal }
		);
		const parsed = parseJson<{ sufficient: boolean; gaps: string[] }>(raw);
		if (!parsed || parsed.sufficient) return [];
		return (parsed.gaps ?? [])
			.filter((g) => typeof g === 'string' && g.trim())
			.slice(0, config.orchestrator.maxSubagentsPerRound);
	} catch {
		return [];
	}
}

function synthesisPrompt(question: string, findings: Finding[], pool: CitationPool): string {
	const body = findings
		.map(
			(f) =>
				`### ${f.query}\nConfidence: ${f.confidence}\nSources: ${
					f.markers.map((m) => `[${m}]`).join('') || 'none'
				}\n${f.summary}`
		)
		.join('\n\n');

	// Titles only -- the lead must be able to attribute markers without the token
	// cost of the chunk bodies. This is what keeps deep mode inside 32k.
	const index = pool.entries
		.map(
			(c, i) =>
				`[${i + 1}] ${c.title}${c.headingPath.length ? ` › ${c.headingPath.join(' › ')}` : ''}`
		)
		.join('\n');

	return `Question: ${question}

Research findings from your subagents:

${body}

Source index (cite by these numbers):
${index}

Write the final answer from these findings. Keep the citation markers exactly as numbered above. Do not invent sources or markers.`;
}

async function* answer(
	userContent: string,
	input: RunInput,
	signal: AbortSignal,
	image: ChosenImage | null = null,
	documents: DocumentFindings | null = null,
	externalOffset = 0
): AsyncGenerator<OrchestratorEvent> {
	// Attached files go in front of the sources, not into the retrieval query:
	// a 200-line job script pasted into a search query buries the actual question.
	const withFiles = input.attachedFiles?.length
		? input.attachedFiles
				.map((f) => `The user attached this file.\n\n=== ${f.filename} ===\n${f.content}\n`)
				.join('\n') +
			`\n${userContent}`
		: userContent;

	const content: Message['content'] = input.images?.length
		? [
				{ type: 'text', text: withFiles },
				...input.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
			]
		: withFiles;

	// The strict grounding rule otherwise makes the model refuse to look at an
	// attachment at all, so relax it for the image specifically.
	let system = input.images?.length ? ANSWER_SYSTEM + IMAGE_ADDENDUM : ANSWER_SYSTEM;

	// Only when there is something to edit: an empty file list would invite the
	// model to invent a filename to use the syntax on.
	if (input.generatedFiles?.length) {
		system += fill(EDIT_ADDENDUM, {
			files: input.generatedFiles.map((f) => `- ${f.filename} (${f.bytes} bytes)`).join('\n')
		});
	}

	// Only when the agent actually found something. An addendum describing
	// external sources that do not exist invites the model to cite one.
	if (documents?.summary && documents.sources.length > 0) {
		const first = externalOffset + 1;
		const last = externalOffset + documents.sources.length;
		system += fill(DOCS_RESULT_ADDENDUM, {
			range: first === last ? `[${first}]` : `[${first}]–[${last}]`,
			summary: documents.summary.replace(/\[(\d+)\]/g, (whole, n) => {
				const local = Number(n);
				return local >= 1 && local <= documents.sources.length
					? `[${externalOffset + local}]`
					: whole;
			})
		});
	}

	if (image) {
		system += fill(IMAGE_RESULT_ADDENDUM, {
			caption: image.caption,
			url: image.url,
			title: image.record.title,
			credit: image.record.copyright ?? 'GSI/FAIR'
		});
	}

	for await (const token of stream(
		[{ role: 'system', content: system }, ...input.history, { role: 'user', content }],
		{ maxTokens: 2048, temperature: 0.2, signal }
	)) {
		yield { type: 'token', text: token };
	}
}
