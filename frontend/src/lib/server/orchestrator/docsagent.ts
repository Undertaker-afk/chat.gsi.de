/**
 * The documents agent.
 *
 * Unlike the research subagents it does not search the corpus. It searches the
 * places the crawler cannot reach -- indico.gsi.de, repository.gsi.de, and the
 * PDFs that crawled pages link to but that were never themselves crawled -- and
 * reads what it finds.
 *
 * It runs on EVERY turn, in both modes. That is the one thing about it that is
 * unusual, and it is a deliberate choice rather than an oversight:
 *
 *   * A planner deciding "does this need Indico?" would have to know what is in
 *     Indico to answer, and it does not. The image agent can be gated on intent
 *     ("zeig mir") because wanting a picture is visible in the question; wanting
 *     a slide deck from a 2021 collaboration meeting is not.
 *   * It is off the critical path. It is started before retrieval and awaited
 *     just before the answer is written, so on a normal turn it costs no
 *     wall-clock at all -- the corpus work it runs alongside takes longer.
 *   * It cannot fail a turn. Every path returns a result object, never throws.
 *     An answer without external documents is fine; an answer that failed
 *     because indico.gsi.de was slow is not.
 *
 * The context discipline is the same as everywhere else in this orchestrator:
 * the lead never sees the fetched PDF text. It sees the agent's findings and a
 * numbered source list, exactly as it does for research subagents.
 */
import { config } from '../config';
import { complete, parseJson } from '../llm';
import { log } from '../log';
import { metrics } from '../metrics';
import { ScopeError } from '../pdfscope';
import { linkedDocuments, readDocument, type ReadDocument } from '../sources/documents';
import { EXTRACTABLE_EXTENSIONS } from '../sources/extract';
import { searchIndico, type IndicoHit } from '../sources/indico';
import { recordMetadata, searchRepository, type RepositoryHit } from '../sources/repository';
import { DOCS_PICK_SYSTEM, DOCS_QUERY_SYSTEM, DOCS_READ_SYSTEM } from './prompts';

/** A document source, as it will be cited. */
export interface DocumentSource {
	origin: 'indico' | 'repository' | 'corpus-link';
	url: string;
	title: string;
	/** Event trail, journal reference, or the page that linked it. */
	context: string;
	date: string | null;
	/**
	 * Whether we actually read the contents, or only its metadata.
	 *
	 * This is the honest bit. Indico PDFs we read. Repository records we cannot
	 * fetch at all and have no abstract for either (see sources/repository.ts),
	 * so they are a bibliographic pointer and nothing more. Presenting both as
	 * "a source" without the distinction would be a quiet lie.
	 */
	read: boolean;
}

export interface DocumentFindings {
	/** What the agent concluded, or null when nothing was relevant. */
	summary: string | null;
	/** Sources in citation order; markers are 1-based indices into this. */
	sources: DocumentSource[];
	/** Counters for the trace, so a reader can see the funnel. */
	searched: number;
	read: number;
}

const EMPTY: DocumentFindings = { summary: null, sources: [], searched: 0, read: 0 };

/** How many candidates each source contributes before the model picks. */
const PER_SOURCE = 8;

interface Candidate {
	origin: DocumentSource['origin'];
	url: string;
	title: string;
	context: string;
	date: string | null;
	/** Only fetchable candidates are worth a read slot. */
	readable: boolean;
	/** Repository hits carry their id so metadata can be filled in later. */
	repository?: RepositoryHit;
}

function fromIndico(hit: IndicoHit): Candidate {
	return {
		origin: 'indico',
		url: hit.url,
		title: hit.title,
		context: hit.context,
		date: hit.date,
		// Only attachments are documents. An event is a page about documents, and
		// spending a read slot on one gets us an HTML agenda.
		//
		// Slide decks are the majority of what Indico holds and most of them are
		// .pptx, so restricting this to PDFs threw away the format the site is
		// actually made of -- visible in the UI as decks marked "nur Metadaten"
		// that we could in fact have read.
		readable:
			hit.kind === 'attachment' && EXTRACTABLE_EXTENSIONS.test(hit.filename ?? hit.url)
	};
}

export async function runDocumentsAgent(
	question: string,
	corpusDocumentIds: Promise<number[]>,
	signal: AbortSignal
): Promise<DocumentFindings> {
	if (!config.documents.enabled) return EMPTY;
	try {
		return await gather(question, corpusDocumentIds, signal);
	} catch {
		// Including AbortError when the turn's budget runs out. The answer is
		// written from the corpus either way.
		metrics.documentAgentRuns.inc({ outcome: 'error' });
		return EMPTY;
	}
}

async function gather(
	question: string,
	corpusDocumentIds: Promise<number[]>,
	signal: AbortSignal
): Promise<DocumentFindings> {
	const terms = await searchTerms(question, signal);

	// An empty query means the question contained no name or technical term worth
	// searching for. Searching anyway returns generic noise, which then costs a
	// triage call to reject.
	if (!terms.query) {
		metrics.documentAgentRuns.inc({ outcome: 'no_query' });
		return EMPTY;
	}

	// All three searches in parallel, none allowed to reject: one dead source
	// must not cost the other two.
	let [indico, repository, linked] = await Promise.all([
		searchIndico(terms.query, PER_SOURCE, signal).catch(() => []),
		searchRepository(terms.query, PER_SOURCE, signal).catch(() => []),
		// Awaited inside, not before: the two web searches do not need retrieval
		// to have finished, so the agent starts at the same moment the corpus work
		// does and this resolves while they are in flight.
		corpusDocumentIds.then((ids) => linkedDocuments(ids, PER_SOURCE)).catch(() => [])
	]);

	// Broaden once. These indexes are AND-based, so two terms that are each
	// common can still intersect to nothing -- and the single distinctive term is
	// usually the one that was going to carry the query anyway.
	if (indico.length === 0 && repository.length === 0 && terms.fallback && terms.fallback !== terms.query) {
		[indico, repository] = await Promise.all([
			searchIndico(terms.fallback, PER_SOURCE, signal).catch(() => []),
			searchRepository(terms.fallback, PER_SOURCE, signal).catch(() => [])
		]);
		if (indico.length || repository.length) {
			metrics.externalSearches.inc({ source: 'all', outcome: 'broadened' });
		}
	}

	const candidates: Candidate[] = [
		...indico.map(fromIndico),
		...repository.map((hit) => ({
			origin: 'repository' as const,
			url: hit.url,
			title: hit.title,
			context: 'GSI Repository',
			date: hit.date,
			// Invenio's files are behind the bot challenge; we can never read one.
			readable: false,
			repository: hit
		})),
		...linked.map((link) => ({
			origin: 'corpus-link' as const,
			url: link.url,
			title: decodeURIComponent(link.url.split('/').pop() || link.url),
			context: `verlinkt in: ${link.fromTitle}`,
			date: null,
			readable: true
		}))
	];

	// The same paper is routinely both a repository record and a PDF linked from
	// a wiki page. Keep the first, which is the higher-ranked source.
	const seen = new Set<string>();
	const unique = candidates.filter((c) => {
		const key = c.url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	if (unique.length === 0) {
		metrics.documentAgentRuns.inc({ outcome: 'no_candidates' });
		return { ...EMPTY, searched: 0 };
	}

	const maxReads = config.documents.maxReads;
	const picked = await pick(question, unique, maxReads, signal);
	if (picked.length === 0) {
		metrics.documentAgentRuns.inc({ outcome: 'nothing_relevant' });
		// Logged, not silent: "triage rejected everything" and "the searches found
		// nothing" both surface as state:none in the UI, and only one of them is a
		// prompt problem. Not having this line cost a debugging round.
		log.info('documents agent picked nothing', {
			kind: 'docsagent',
			query: terms.query,
			candidates: unique.length
		});
		return { ...EMPTY, searched: unique.length };
	}

	// Reads run in parallel and failures are dropped rather than fatal: a dead
	// link on one candidate must not cost the other two.
	const readable = picked.filter((c) => c.readable).slice(0, maxReads);
	const documents = (
		await Promise.all(
			readable.map(async (candidate) => {
				try {
					return { candidate, document: await readDocument(candidate.url) };
				} catch (e) {
					// ScopeError is the ordinary case: a dead link, a login page, a
					// scanned PDF with no text layer.
					if (!(e instanceof ScopeError)) throw e;
					return null;
				}
			})
		)
	).filter((r): r is { candidate: Candidate; document: ReadDocument } => r !== null);

	// Repository hits get their authors and publication reference -- all we can
	// ever have of them, since the files are unreachable and no abstract is
	// published in any of this instance's OAI formats.
	const enriched = new Map(
		await Promise.all(
			picked
				.filter((c) => c.origin === 'repository' && c.repository)
				.slice(0, maxReads)
				.map(
					async (c) =>
						[c.url, await recordMetadata(c.repository!, signal)] as const
				)
		)
	);

	// EVERY picked candidate becomes a source, whether or not we read it.
	//
	// The first version only emitted documents it had read plus repository
	// records, which silently dropped anything else -- an Indico .pptx deck, an
	// event page, a PDF whose link had rotted. Those are exactly as useful a
	// pointer as a repository record is, and dropping them meant a question whose
	// only relevant material was a slide deck produced no sources at all.
	//
	// What separates them is `read`, not whether they appear -- so there is no
	// filter here at all. The first attempt at this fix kept one
	// (`readByUrl.has(url) || origin === 'repository' || !readable`) and still
	// dropped the case it was written for: a PDF we picked, tried to fetch, and
	// failed on. That one is `readable`, is not in `readByUrl`, and is not a
	// repository record, so every clause was false. A link we could not follow is
	// still a link worth showing a reader.
	const readByUrl = new Map(documents.map((d) => [d.candidate.url, d.document]));
	const sources: DocumentSource[] = picked
		.map((candidate) => {
			const record = enriched.get(candidate.url);
			return {
				origin: candidate.origin,
				url: candidate.url,
				title: record?.title ?? candidate.title,
				context: record?.source ?? candidate.context,
				date: record?.date ?? candidate.date,
				read: readByUrl.has(candidate.url)
			};
		})
		// Read documents first: they carry evidence, the rest carry only a name.
		.sort((a, b) => Number(b.read) - Number(a.read));

	// Unreachable in practice now that every picked candidate becomes a source;
	// kept because "picked something, produced no source" would be a logic error
	// worth seeing rather than an empty answer worth ignoring.
	if (sources.length === 0) {
		metrics.documentAgentRuns.inc({ outcome: 'no_sources' });
		log.warn('documents agent picked candidates but produced no source', {
			kind: 'docsagent',
			query: terms.query,
			candidates: unique.length,
			picked: picked.length
		});
		return { ...EMPTY, searched: unique.length };
	}

	const summary = await read(question, readByUrl, enriched, sources, signal);

	metrics.documentAgentRuns.inc({ outcome: summary ? 'ok' : 'nothing_relevant' });
	log.info('documents agent finished', {
		kind: 'docsagent',
		query: terms.query,
		candidates: unique.length,
		picked: picked.length,
		read: documents.length,
		sources: summary ? sources.length : 0,
		relevant: Boolean(summary)
	});
	return {
		summary,
		// A source the model found nothing in should not be offered as a source.
		sources: summary ? sources : [],
		searched: unique.length,
		read: documents.length
	};
}

/** German and English question scaffolding, for the fallback path only. */
const STOPWORDS = new Set(
	`was wie wo wer warum wieso welche welcher welches wann macht machen ist sind kann
	 kannst muss soll gibt es der die das den dem des ein eine einen einem einer und
	 oder aber fuer für mit von zum zur auf bei im in an als auch nicht mir mich ich
	 wir sie man bitte bei über uber what how where who why which when does do is are
	 can could should the a an and or but for with from to at in on of my me i we you
	 please about into`
		.split(/\s+/)
		.filter(Boolean)
);

/**
 * The keyword query, and a single-term fallback.
 *
 * Not optional and not cosmetic: the raw question finds nothing. See
 * DOCS_QUERY_SYSTEM for the measurement.
 */
async function searchTerms(
	question: string,
	signal: AbortSignal
): Promise<{ query: string; fallback: string }> {
	try {
		const raw = await complete(
			[
				{ role: 'system', content: DOCS_QUERY_SYSTEM },
				{ role: 'user', content: question }
			],
			{ model: config.llm.utilityModel, maxTokens: 120, temperature: 0, json: true, signal }
		);
		const parsed = parseJson<{ query: string; fallback: string }>(raw);
		const query = String(parsed?.query ?? '').trim().slice(0, 120);
		const fallback = String(parsed?.fallback ?? '').trim().slice(0, 60);
		// A model that ignores "" tends to write "null" instead, and searching for
		// the literal string null returns nothing forever.
		const clean = (s: string) => (s.toLowerCase() === 'null' ? '' : s);
		if (query) return { query: clean(query), fallback: clean(fallback) };
	} catch {
		/* fall through to the heuristic */
	}

	// Heuristic: drop question scaffolding and keep the most distinctive words.
	// Acronyms and names survive because they are long or capitalised; this is
	// much worse than the model at it, but it is never worse than the raw
	// question, which is what it replaces.
	const words = question
		.replace(/[?!.,;:„“"'()]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
	const ranked = [...words].sort(
		(a, b) => score(b) - score(a) || b.length - a.length
	);
	return { query: ranked.slice(0, 2).join(' '), fallback: ranked[0] ?? '' };
}

/** All-caps acronyms and capitalised names are what these indexes match on. */
function score(word: string): number {
	if (/^[A-ZÄÖÜ0-9]{2,}$/.test(word)) return 3;
	if (/^[A-ZÄÖÜ]/.test(word)) return 2;
	return 1;
}

/**
 * Choose which candidates are worth a download.
 *
 * Titles and event trails only. Judging from a filename is imprecise, but the
 * alternative is downloading eight PDFs to find out that seven were irrelevant,
 * and the utility model does this in well under a second.
 */
async function pick(
	question: string,
	candidates: Candidate[],
	maxReads: number,
	signal: AbortSignal
): Promise<Candidate[]> {
	const listing = candidates
		.map((c, i) => `${i + 1}. [${c.origin}] ${c.title}${c.context ? ` — ${c.context}` : ''}`)
		.join('\n');

	try {
		const raw = await complete(
			[
				{ role: 'system', content: DOCS_PICK_SYSTEM },
				{ role: 'user', content: `Question: ${question}\n\nCandidates:\n${listing}` }
			],
			{
				model: config.llm.utilityModel,
				maxTokens: 300,
				temperature: 0,
				json: true,
				signal
			}
		);
		const parsed = parseJson<{ pick: number[] }>(raw);
		const chosen = (parsed?.pick ?? [])
			.filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length)
			.map((n) => candidates[n - 1]);
		return [...new Set(chosen)].slice(0, maxReads * 2);
	} catch {
		// Without a judgement, fall back to the first few by search rank: a weak
		// signal, but not no signal.
		//
		// NOT filtered to `readable`. That was the bug: repository records are
		// never readable, so a triage failure on an all-repository candidate list
		// returned nothing at all -- and the utility model returning unparseable
		// JSON is a known failure mode here (gpt-oss answers `content: null` when
		// the token budget goes to reasoning). The result looked exactly like
		// "triage rejected everything", which is why it needed a log line to find.
		return candidates.slice(0, maxReads);
	}
}

/** Summarise what the documents say, with markers into `sources`. */
async function read(
	question: string,
	readByUrl: Map<string, ReadDocument>,
	enriched: Map<string, Awaited<ReturnType<typeof recordMetadata>>>,
	sources: DocumentSource[],
	signal: AbortSignal
): Promise<string | null> {
	const body = sources
		.map((source, i) => {
			const full = readByUrl.get(source.url);
			if (full) {
				const note = full.truncated ? ' (Anfang des Dokuments)' : '';
				return `[${i + 1}] ${source.title} — ${source.context}${note}\n${full.text}`;
			}
			const record = enriched.get(source.url);
			return (
				`[${i + 1}] ${source.title} — ${source.context}\n` +
				`METADATA ONLY. The document was not retrieved and cannot be.\n` +
				`Authors: ${record?.authors.join(', ') || 'unknown'}\n` +
				`Published: ${record?.source ?? 'unknown'}\n` +
				// Almost always "not available" -- this repository publishes no
				// abstracts in any OAI format (see sources/repository.ts). Stated
				// explicitly so the model treats it as a known absence rather than
				// filling the gap.
				`Abstract: ${record?.abstract ?? 'not available — you have not seen this document'}`
			);
		})
		.join('\n\n---\n\n');

	try {
		const raw = await complete(
			[
				{ role: 'system', content: DOCS_READ_SYSTEM },
				{ role: 'user', content: `Question: ${question}\n\nDocuments:\n\n${body}` }
			],
			{ maxTokens: 700, temperature: 0.1, json: true, signal }
		);
		const parsed = parseJson<{ relevant: boolean; summary: string }>(raw);
		if (!parsed || parsed.relevant === false) return null;
		const summary = String(parsed.summary ?? '').trim();
		return summary || null;
	} catch {
		return null;
	}
}
