/**
 * The image subagent.
 *
 * Runs only in deep mode, and only when the planner decided the question wants
 * a picture. It is a genuine subagent in the same sense as the research ones:
 * it does its own retrieval (a live media.gsi.de search), forms its own
 * judgement (a vision call over the candidates), and returns a single small
 * result to the lead. The lead never sees the candidate images -- that is the
 * same context discipline that keeps chunk text out of the lead.
 *
 * Judging by looking is the point. The library's captions are terse German
 * titles, so "FAIR Baustelle" matches hundreds of records whose usefulness only
 * differs visually: an aerial of the whole site, a close-up of rebar, a portrait
 * taken on the site. Ranking on metadata alone picks the wrong one confidently.
 */
import { config } from '../config';
import { complete, parseJson, type Message } from '../llm';
import { asDataUrl, getRecord, searchMedia, type MediaRecord } from '../media';
import { IMAGE_JUDGE_SYSTEM } from './prompts';

/** How many previews the vision call looks at. Each is roughly 40 kB. */
const CANDIDATES = 6;

export interface ChosenImage {
	record: MediaRecord;
	/** One-line German caption, written for this question. */
	caption: string;
	/** Where an answer should point: our proxy, not the signed origin URL. */
	url: string;
	candidates: number;
	/** What the library was actually asked, once broadening had its say. */
	effectiveQuery: string;
}

export async function runImageAgent(
	query: string,
	signal: AbortSignal
): Promise<ChosenImage | null> {
	const { hits, effectiveQuery } = await searchMedia(query, CANDIDATES);
	if (hits.length === 0) return null;

	// Previews are fetched in parallel and failures are dropped rather than
	// fatal: one expired token must not cost the whole search.
	const loaded = (
		await Promise.all(
			hits.map(async (hit) => {
				try {
					return { hit, dataUrl: await asDataUrl(hit.previewUrl) };
				} catch {
					return null;
				}
			})
		)
	).filter((x): x is { hit: (typeof hits)[number]; dataUrl: string } => x !== null);

	if (loaded.length === 0) return null;

	const content: Message['content'] = [
		{
			type: 'text',
			text:
				`Question: ${query}\n\n` +
				`${loaded.length} candidate images follow, numbered 1 to ${loaded.length} in order.`
		},
		...loaded.map((l) => ({ type: 'image_url' as const, image_url: { url: l.dataUrl } }))
	];

	let choice: { index: number; caption: string } | null = null;
	try {
		const raw = await complete(
			[
				{ role: 'system', content: IMAGE_JUDGE_SYSTEM },
				{ role: 'user', content }
			],
			{ model: config.llm.chatModel, maxTokens: 300, temperature: 0.1, json: true, signal }
		);
		const parsed = parseJson<{ best: number; caption: string; suitable: boolean }>(raw);
		// `suitable: false` is a real answer: a search that returned only unrelated
		// pictures should produce no image, not the least-bad one.
		if (parsed && parsed.suitable !== false) {
			const index = Number(parsed.best) - 1;
			if (Number.isInteger(index) && index >= 0 && index < loaded.length) {
				choice = { index, caption: String(parsed.caption ?? '').trim() };
			}
		}
	} catch {
		return null;
	}
	if (!choice) return null;

	const winner = loaded[choice.index].hit;
	const record = await getRecord(winner.id, winner.uri);
	if (!record) return null;

	return {
		record,
		caption: choice.caption || record.title,
		// Our own endpoint: the origin URL is signed and expires, so an answer
		// stored today would show a broken image next week.
		url: `/api/media/${record.id}`,
		candidates: loaded.length,
		effectiveQuery
	};
}
