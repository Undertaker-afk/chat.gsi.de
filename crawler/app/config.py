"""Crawler configuration, read from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env(key: str, default: str | None = None) -> str:
    value = os.environ.get(key, default)
    if value is None:
        raise RuntimeError(f"missing required environment variable: {key}")
    return value


@dataclass(frozen=True)
class Config:
    # GSI LLM proxy. Paths verified 2026-07-27: the base ends in /api/v1, and
    # chat lives at /api/v1/chat/completions -- NOT /api/chat/completions, which
    # info.md documents but which returns 403.
    llm_base_url: str
    llm_api_key: str
    crawl_model: str
    embedding_model: str
    embed_batch_size: int

    database_url: str
    valkey_url: str

    corpus_dir: Path
    rate_limit_rps: float
    user_agent: str
    vision_enabled: bool
    llm_extraction: bool

    #: Pages processed in parallel. The work per page is almost entirely waiting
    #: on the LLM proxy (~27 s of a ~28 s page), so this is I/O-bound and threads
    #: are the right tool -- the GIL is released across those requests.
    #:
    #: It does NOT loosen any rate limit: connector throttling reserves slots
    #: under a lock, so the aggregate request rate to a crawled host is the same
    #: at any worker count. What it multiplies is load on the LLM proxy at
    #: 192.168.50.1, which is shared infrastructure -- that, not the crawler, is
    #: what to watch when raising this.
    concurrency: int = 4

    # Chunking (plan.md §5)
    chunk_target_tokens: int = 512
    chunk_max_tokens: int = 1024
    section_whole_max_tokens: int = 1200
    chunk_overlap_ratio: float = 0.15

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            llm_base_url=_env("LLM_BASE_URL", "http://192.168.50.1:8080/api/v1").rstrip("/"),
            llm_api_key=_env("LLM_API_KEY"),
            crawl_model=_env("CRAWL_MODEL", "llmbot.qwen3.6-27b"),
            embedding_model=_env("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-8B"),
            embed_batch_size=int(_env("EMBED_BATCH_SIZE", "32")),
            database_url=_env("DATABASE_URL"),
            valkey_url=_env("VALKEY_URL", "redis://valkey:6379"),
            corpus_dir=Path(_env("CORPUS_DIR", "/data/corpus")),
            rate_limit_rps=float(_env("CRAWL_RATE_LIMIT_RPS", "0.2")),
            user_agent=_env("CRAWL_USER_AGENT", "gsi-llmbot-crawler/1.0 (+https://chat.gsi.de)"),
            vision_enabled=_env("CRAWL_VISION_ENABLED", "true").lower() in ("1", "true", "yes"),
            llm_extraction=_env("CRAWL_LLM_EXTRACTION", "true").lower() in ("1", "true", "yes"),
            concurrency=max(1, int(_env("CRAWL_CONCURRENCY", "4"))),
        )
