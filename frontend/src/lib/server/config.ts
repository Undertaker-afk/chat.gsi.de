import { env } from '$env/dynamic/private';

/**
 * Runtime configuration.
 *
 * Every value is a LAZY getter. SvelteKit's build-time analysis imports server
 * modules with no environment present, so evaluating `required()` at module load
 * breaks `vite build` with "missing required environment variable". Deferring to
 * first access keeps the build working while still failing loudly at runtime if
 * something is genuinely unset.
 */
function required(key: string, fallback?: string): string {
	const value = env[key] ?? fallback;
	if (!value) throw new Error(`missing required environment variable: ${key}`);
	return value;
}

function num(key: string, fallback: number): number {
	const raw = env[key];
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got: ${raw}`);
	return parsed;
}

/**
 * A JSON object of `canonical role => alias name or list of names`, parsed once.
 *
 * This is what lets an EXTERNAL identity provider work without touching the
 * app's role names: the realm keeps calling people `admin`/`staff`, and this map
 * says which of those count as `llmbot-admin`/`llmbot-user`. Empty is the normal
 * case (the bundled Keycloak already issues the canonical names).
 */
function roleAliasMap(key: string): Record<string, string[]> {
	const raw = env[key];
	if (!raw || !raw.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${key} must be valid JSON, got: ${raw}`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${key} must be a JSON object of role => alias(es)`);
	}
	const out: Record<string, string[]> = {};
	for (const [canonical, aliases] of Object.entries(parsed as Record<string, unknown>)) {
		out[canonical] = Array.isArray(aliases) ? aliases.map(String) : [String(aliases)];
	}
	return out;
}

export const config = {
	// GSI LLM proxy. Verified 2026-07-27: the base ends in /api/v1. Note that
	// /api/chat/completions (as documented in info.md) returns 403 -- the working
	// path is /api/v1/chat/completions.
	llm: {
		get baseUrl() {
			return required('LLM_BASE_URL', 'http://192.168.50.1:8080/api/v1').replace(/\/$/, '');
		},
		get apiKey() {
			return required('LLM_API_KEY');
		},
		get chatModel() {
			return required('CHAT_MODEL', 'llmbot.mistral-small-4-119b');
		},
		get utilityModel() {
			return required('UTILITY_MODEL', 'llmbot.gpt-oss-120b');
		},
		get embeddingModel() {
			return required('EMBEDDING_MODEL', 'Qwen/Qwen3-Embedding-8B');
		},
		get contextWindow() {
			return num('LLM_CONTEXT_WINDOW', 200000);
		}
	},
	db: {
		get url() {
			return required('DATABASE_URL');
		}
	},
	valkey: {
		get url() {
			return required('VALKEY_URL', 'redis://valkey:6379');
		}
	},
	oidc: {
		get issuer() {
			return required('OIDC_ISSUER', 'http://keycloak.localhost:8081/realms/gsi');
		},
		get clientId() {
			return required('OIDC_CLIENT_ID', 'chat-gsi-de');
		},
		get clientSecret() {
			return required('OIDC_CLIENT_SECRET');
		},
		get redirectUri() {
			return required('OIDC_REDIRECT_URI', 'http://localhost:3000/auth/callback');
		},
		get sessionSecret() {
			return required('SESSION_SECRET');
		},
		/**
		 * Dotted path to the roles array in the token. The bundled Keycloak puts
		 * realm roles under `realm_access.roles`; a client mapper that lifts them
		 * to a top-level claim would be `roles`; a per-client role lives at
		 * `resource_access.<client>.roles`.
		 */
		get rolesClaim() {
			return required('OIDC_ROLES_CLAIM', 'realm_access.roles');
		},
		/** External role name(s) → the app's canonical `llmbot-*` roles. */
		get roleAliases() {
			return roleAliasMap('OIDC_ROLE_ALIASES');
		}
	},
	orchestrator: {
		get maxRounds() {
			return num('MAX_ROUNDS', 3);
		},
		get maxSubagentsPerRound() {
			return num('MAX_SUBAGENTS_PER_ROUND', 4);
		},
		get wallClockBudgetMs() {
			return num('DEEP_WALL_CLOCK_BUDGET_S', 180) * 1000;
		},
		get retrieveTopK() {
			return num('RETRIEVE_TOP_K', 40);
		},
		get contextChunksFast() {
			return num('CONTEXT_CHUNKS_FAST', 8);
		},
		get contextChunksDeep() {
			return num('CONTEXT_CHUNKS_DEEP', 12);
		}
	},
	/**
	 * The external documents agent. Runs on every turn against indico.gsi.de,
	 * repository.gsi.de and PDFs linked from the corpus.
	 *
	 * `enabled` is a real off switch, not a feature flag waiting to be removed:
	 * this is the one part of a turn that reaches hosts we do not run, and an
	 * operator needs to be able to stop that without a redeploy.
	 */
	documents: {
		get enabled() {
			return (env.DOCS_AGENT_ENABLED ?? 'true') !== 'false';
		},
		/** Downloads per turn. Each one is a real fetch from a real GSI server. */
		get maxReads() {
			return num('DOCS_AGENT_MAX_READS', 3);
		},
		get maxTextChars() {
			return num('DOCS_AGENT_MAX_TEXT_CHARS', 12_000);
		}
	},
	uploads: {
		get quotaBytes() {
			return num('UPLOAD_QUOTA_BYTES', 1024 * 1024 * 1024); // 1 GiB per user
		},
		/**
		 * Per file. Keep BODY_SIZE_LIMIT on the Deployment comfortably above this:
		 * adapter-node caps request bodies itself (512K by default) and will close
		 * the socket before this check ever runs, which reads as a broken upload
		 * rather than as a limit.
		 */
		get maxFileBytes() {
			return num('UPLOAD_MAX_FILE_BYTES', 4 * 1024 * 1024);
		},
		/**
		 * Characters of extracted text one attached document contributes to a turn.
		 *
		 * Larger than the documents agent's budget (12k): a file the user chose to
		 * attach is the subject of their question, whereas a search hit is one of
		 * several the agent guessed at.
		 */
		get maxAttachmentChars() {
			return num('UPLOAD_MAX_ATTACHMENT_CHARS', 30_000);
		}
	},
	/**
	 * Read-only directory access (plan.md §8b). Optional: without it the admin
	 * user picker lists only people who have already logged in.
	 */
	keycloak: {
		get baseUrl() {
			return required('KEYCLOAK_BASE_URL', 'http://keycloak.localhost:8081').replace(/\/$/, '');
		},
		/**
		 * The MANAGEMENT port (9000), where /health lives. Separate from baseUrl on
		 * purpose: baseUrl is the issuer host and must stay byte-identical to what
		 * the browser uses (AGENTS.md §5), while health checks are an internal
		 * call that never appears in a token.
		 */
		get managementUrl() {
			return (env.KEYCLOAK_MANAGEMENT_URL ?? 'http://keycloak:9000').replace(/\/$/, '');
		},
		get realm() {
			return required('KEYCLOAK_REALM', 'gsi');
		},
		get adminClientId() {
			return env.KEYCLOAK_ADMIN_CLIENT_ID ?? '';
		},
		get adminClientSecret() {
			return env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? '';
		}
	},
	access: {
		/** How long a conversation stays hidden before it is purged for good. */
		get revocationGraceDays() {
			return num('REVOCATION_GRACE_DAYS', 30);
		}
	},
	/** SeaweedFS S3 gateway. See compose.yaml and deploy/seaweedfs/s3.json. */
	s3: {
		get endpoint() {
			return required('S3_ENDPOINT', 'http://seaweed-s3:8333').replace(/\/$/, '');
		},
		/**
		 * Where the BROWSER reaches the gateway. Presigned links are signed for
		 * this host, so it must differ from `endpoint` whenever the container
		 * network name is not resolvable outside.
		 */
		get publicEndpoint() {
			return required('S3_PUBLIC_ENDPOINT', 'http://localhost:8333').replace(/\/$/, '');
		},
		get region() {
			return required('S3_REGION', 'us-east-1');
		},
		get bucket() {
			return required('S3_BUCKET', 'gsi-uploads');
		},
		get accessKey() {
			return required('S3_ACCESS_KEY');
		},
		get secretKey() {
			return required('S3_SECRET_KEY');
		},
		get linkTtlSeconds() {
			return num('S3_LINK_TTL_SECONDS', 300);
		},
		/**
		 * The SeaweedFS master, for cluster metrics only. Never used for object
		 * access -- that goes through the S3 gateway above.
		 */
		get masterUrl() {
			return (env.S3_MASTER_URL ?? 'http://seaweed-master:9333').replace(/\/$/, '');
		},
		/**
		 * Planned object-storage capacity, the denominator of the storage gauge on
		 * the Grafana dashboard. 25 TB, expressed in TiB-style units to match how
		 * Grafana's `bytes` unit renders it.
		 *
		 * This is a TARGET, not a measurement -- the lab node does not have 25 TB
		 * attached. Physically available bytes are reported separately as
		 * chatgsi_seaweed_disk_bytes; see collectors.ts.
		 */
		get capacityBytes() {
			return num('S3_CAPACITY_BYTES', 25 * 1024 ** 4);
		}
	},
	/**
	 * The metrics server (see $lib/server/metrics). One registry, one /metrics
	 * endpoint, and a scrape that fans out to every backend.
	 */
	metrics: {
		get enabled() {
			return (env.METRICS_ENABLED ?? 'true') !== 'false';
		},
		/**
		 * Bearer token for /metrics. Unset on the lab subnet, which is deliberately
		 * open (AGENTS.md §1). Set it if this ever gets an internet-facing ingress:
		 * the exposition names users.
		 */
		get token() {
			return env.METRICS_TOKEN ?? '';
		},
		/**
		 * How long a scrape-time collector's answer is reused. Prometheus scrapes
		 * every 15s; without this, a Grafana panel on auto-refresh plus a couple of
		 * open browser tabs would run the storage aggregation continuously.
		 */
		get dbCacheMs() {
			return num('METRICS_CACHE_SECONDS', 15) * 1000;
		},
		/** Per-backend timeout inside a scrape. Must stay under Prometheus's own. */
		get timeoutMs() {
			return num('METRICS_TIMEOUT_SECONDS', 5) * 1000;
		},
		get version() {
			return env.APP_VERSION ?? 'dev';
		}
	},
	/** Dev-only auth bypass. Hard-gated on NODE_ENV so it cannot ship. */
	get devNoAuth() {
		return env.NODE_ENV === 'development' && env.DEV_NO_AUTH === 'true';
	}
};
