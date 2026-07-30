/**
 * Every application-side metric, declared in one place.
 *
 * Instrumentation elsewhere imports from here and never touches the registry
 * directly. Keeping the declarations together is what makes it possible to
 * answer "what does /metrics expose?" by reading one file, and it is where the
 * cardinality budget is enforced: if a label is added below, this is the place
 * it has to be justified.
 *
 * Label rules that matter:
 *   - `route` is the SvelteKit route ID (`/api/conversations/[id]`), never the
 *     resolved path — otherwise every conversation id becomes its own series.
 *   - `model` comes from configuration, not from user input.
 *   - `outcome` is a small closed set: ok | error | aborted.
 */
import { registry, SIZE_BUCKETS } from './registry';

// --- HTTP -------------------------------------------------------------------

export const httpRequests = registry.counter(
	'chatgsi_http_requests_total',
	'HTTP requests handled, by route, method and status class.',
	['route', 'method', 'status']
);

export const httpDuration = registry.histogram(
	'chatgsi_http_request_duration_seconds',
	'Wall-clock time to produce an HTTP response, excluding SSE streaming time.',
	['route', 'method']
);

export const httpInFlight = registry.gauge(
	'chatgsi_http_requests_in_flight',
	'Requests currently being handled.'
);

export const httpDenied = registry.counter(
	'chatgsi_http_denied_total',
	'Requests rejected by the auth gate in hooks.server.ts, by reason.',
	['reason']
);

// --- auth -------------------------------------------------------------------

export const authEvents = registry.counter(
	'chatgsi_auth_events_total',
	'OIDC lifecycle events: login_start, login_ok, login_failed, refresh_ok, refresh_failed, logout.',
	['event']
);

export const activeSessions = registry.gauge(
	'chatgsi_active_sessions',
	'Sessions currently held in Valkey (sess:* keys). Collected at scrape time.'
);

// --- LLM proxy --------------------------------------------------------------

export const llmRequests = registry.counter(
	'chatgsi_llm_requests_total',
	'Calls to the GSI LLM proxy, by endpoint, model and outcome.',
	['endpoint', 'model', 'outcome']
);

export const llmDuration = registry.histogram(
	'chatgsi_llm_request_duration_seconds',
	'Time to a complete LLM response. For streams, time until the last token.',
	['endpoint', 'model']
);

export const llmTimeToFirstToken = registry.histogram(
	'chatgsi_llm_time_to_first_token_seconds',
	'Time from issuing a streaming request until the first token delta arrives.',
	['model'],
	[0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60]
);

export const llmTokens = registry.counter(
	'chatgsi_llm_tokens_total',
	'Tokens reported by the proxy, by model and direction (prompt|completion).',
	['model', 'direction']
);

export const llmErrors = registry.counter(
	'chatgsi_llm_errors_total',
	'Failed LLM calls, by endpoint and HTTP status (or "network" when no response arrived).',
	['endpoint', 'status']
);

// --- embeddings -------------------------------------------------------------

export const embeddingRequests = registry.counter(
	'chatgsi_embedding_requests_total',
	'Embedding batches sent to the proxy, by outcome.',
	['outcome']
);

export const embeddingInputs = registry.counter(
	'chatgsi_embedding_inputs_total',
	'Individual texts embedded, by direction (query|document).',
	['direction']
);

export const embeddingDuration = registry.histogram(
	'chatgsi_embedding_duration_seconds',
	'Time for one embedding batch.',
	['direction']
);

// --- retrieval and the orchestrator ----------------------------------------

export const retrievalDuration = registry.histogram(
	'chatgsi_retrieval_duration_seconds',
	'pgvector similarity search, embedding time included.',
	[]
);

export const retrievalChunks = registry.histogram(
	'chatgsi_retrieval_chunks',
	'Chunks returned by one retrieval.',
	[],
	[1, 5, 10, 20, 40, 80, 160]
);

export const chatTurns = registry.counter(
	'chatgsi_chat_turns_total',
	'Completed chat turns, by mode (fast|deep) and outcome.',
	['mode', 'outcome']
);

export const chatTurnDuration = registry.histogram(
	'chatgsi_chat_turn_duration_seconds',
	'End-to-end orchestrator time for one turn.',
	['mode']
);

export const orchestratorRounds = registry.histogram(
	'chatgsi_orchestrator_rounds',
	'Research rounds spent on a turn. Only gsi-deep exceeds one.',
	['mode'],
	[1, 2, 3, 4]
);

export const orchestratorSubagents = registry.counter(
	'chatgsi_orchestrator_subagents_total',
	'Subagents dispatched, by mode.',
	['mode']
);

export const orchestratorBudgetExhausted = registry.counter(
	'chatgsi_orchestrator_budget_exhausted_total',
	'Turns cut short by DEEP_WALL_CLOCK_BUDGET_S, answered from partial findings.'
);

// --- object storage ---------------------------------------------------------

export const s3Operations = registry.counter(
	'chatgsi_s3_operations_total',
	'S3 gateway calls, by operation and outcome.',
	['operation', 'outcome']
);

export const s3Duration = registry.histogram(
	'chatgsi_s3_operation_duration_seconds',
	'Time for one S3 gateway call.',
	['operation']
);

export const s3Bytes = registry.counter(
	'chatgsi_s3_bytes_total',
	'Bytes moved through the S3 gateway, by direction (up|down).',
	['direction']
);

// --- uploads and quota ------------------------------------------------------

export const uploadsStored = registry.counter(
	'chatgsi_uploads_stored_total',
	'Attachments accepted, by mime type.',
	['mime']
);

export const uploadSize = registry.histogram(
	'chatgsi_upload_size_bytes',
	'Size of accepted attachments.',
	['mime'],
	SIZE_BUCKETS
);

export const uploadsRejected = registry.counter(
	'chatgsi_uploads_rejected_total',
	'Attachments refused, by reason: quota | too_large | unsupported_type.',
	['reason']
);

// --- database ---------------------------------------------------------------

export const dbQueries = registry.counter(
	'chatgsi_db_queries_total',
	'Postgres queries issued by the app, by outcome. Not labelled by statement — the app issues hundreds of distinct ones.',
	['outcome']
);

export const dbDuration = registry.histogram(
	'chatgsi_db_query_duration_seconds',
	'Postgres query time as seen by the app, connection acquisition included.',
	[],
	[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15]
);

// --- crawler control --------------------------------------------------------

/**
 * Admin actions against the crawler. The crawl RUNS themselves are collected
 * from `crawl_runs` at scrape time (the crawler is a batch job with no process
 * to scrape); this counts what the buttons did, which is the frontend's half
 * and the only part of the story the database cannot reconstruct.
 */
export const crawlControlActions = registry.counter(
	'chatgsi_crawl_control_actions_total',
	'Crawler control actions from the admin UI, by action and mode.',
	['action', 'mode']
);

// --- external document cache ------------------------------------------------

export const cacheRequests = registry.counter(
	'chatgsi_external_cache_requests_total',
	'Lookups in the 7-day external document cache, by result (hit|miss|expired|error).',
	['result']
);

export const cacheFetchDuration = registry.histogram(
	'chatgsi_external_cache_fetch_duration_seconds',
	'Time to serve an external document, by whether it came from cache or the origin.',
	['result']
);

export const cacheBytes = registry.counter(
	'chatgsi_external_cache_bytes_total',
	'Bytes served from the external cache, by result. The `hit` line is bandwidth not spent on www.gsi.de.',
	['result']
);

// --- external sources (the documents agent) ---------------------------------
//
// The funnel is the point of these: searches -> hits -> candidates the model
// kept -> documents actually read. A drop between any two stages is a different
// problem. `outcome="challenged"` in particular is the one that will need
// noticing -- it means repository.gsi.de started serving its bot challenge on
// the RSS interface too, which would look exactly like "no results" without a
// label to tell them apart (see sources/repository.ts).

export const externalSearches = registry.counter(
	'chatgsi_external_searches_total',
	'Searches against external document sources, by source and outcome (ok|empty|challenged|error|http_NNN).',
	['source', 'outcome']
);

export const externalHits = registry.counter(
	'chatgsi_external_hits_total',
	'Results returned by external document searches, by source. Compare with searches for hits-per-search.',
	['source']
);

export const documentAgentRuns = registry.counter(
	'chatgsi_document_agent_runs_total',
	'Documents-agent turns by outcome. It runs on every turn, so `nothing_relevant` is the expected majority, not a fault.',
	['outcome']
);

export const documentReads = registry.counter(
	'chatgsi_document_reads_total',
	'External documents fetched and text-extracted, by outcome (fetched|cached|unreadable).',
	['outcome']
);

export const documentReadDuration = registry.histogram(
	'chatgsi_document_read_duration_seconds',
	'Time to fetch and extract one external document, by whether the bytes were cached.',
	['outcome']
);

export const documentPages = registry.histogram(
	'chatgsi_document_pages',
	'Page count of external documents read.',
	[],
	[1, 2, 5, 10, 20, 50, 100, 250]
);

// --- build info -------------------------------------------------------------

/**
 * The conventional `_info` metric: always 1, carrying identity in its labels so
 * a dashboard can display the running version without a second data source.
 */
export const buildInfo = registry.gauge(
	'chatgsi_build_info',
	'Always 1. Labels carry the running version and Node runtime.',
	['version', 'node']
);
