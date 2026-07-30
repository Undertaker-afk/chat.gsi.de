"""Client for the GSI LLM proxy (OpenAI-compatible, vLLM behind Open WebUI).

Every LLM call in the crawler goes through here, so swapping the praktikum proxy for
the real llmbot.gsi.de is a base-URL change and nothing else.
"""

from __future__ import annotations

import base64
import logging
import random
import time
from typing import Any, Callable, Iterable, Sequence, TypeVar

import httpx

from .config import Config

log = logging.getLogger(__name__)

T = TypeVar("T")

#: The proxy returns sporadic 502s under load -- observed during the first trial
#: crawl, where two of five pages failed on unrelated calls seconds apart. A
#: multi-hour full crawl would be destroyed by that without retries, so every
#: call is wrapped.
_RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 5


def _with_retry(operation: Callable[[], T], *, what: str) -> T:
    delay = 2.0
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            return operation()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status not in _RETRY_STATUS or attempt == _MAX_ATTEMPTS:
                raise
            log.warning("%s: HTTP %d, retry %d/%d in %.1fs",
                        what, status, attempt, _MAX_ATTEMPTS, delay)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            if attempt == _MAX_ATTEMPTS:
                raise
            log.warning("%s: %s, retry %d/%d in %.1fs",
                        what, type(exc).__name__, attempt, _MAX_ATTEMPTS, delay)

        # Jitter so a batch of failures does not resynchronise into a thundering herd.
        time.sleep(delay + random.uniform(0, delay * 0.3))
        delay *= 2
    raise RuntimeError("unreachable")

# Qwen3 embedding models are asymmetric: queries carry an instruction prefix,
# documents do not. Mixing this up silently degrades recall, so the prefix is
# defined once, here, and used nowhere else. The crawler only ever embeds
# documents; the query side lives in frontend/src/lib/server/embeddings.ts.
QUERY_INSTRUCTION = (
    "Instruct: Given a web search query, retrieve relevant passages "
    "that answer the query\nQuery: "
)


class LLMClient:
    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._http = httpx.Client(
            base_url=cfg.llm_base_url,
            headers={
                "Authorization": f"Bearer {cfg.llm_api_key}",
                "Content-Type": "application/json",
                # The proxy advertises a Content-Encoding it does not actually
                # apply, so any client offering compression fails with
                # "Error -3 while decompressing data: incorrect header check".
                # Verified 2026-07-27. Do not remove without re-testing.
                "Accept-Encoding": "identity",
            },
            timeout=httpx.Timeout(120.0, connect=10.0),
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "LLMClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- embeddings -----------------------------------------------------------

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed document chunks. No instruction prefix -- see QUERY_INSTRUCTION."""
        out: list[list[float]] = []
        for batch in _batched(texts, self._cfg.embed_batch_size):
            def call(batch: Sequence[str] = batch) -> httpx.Response:
                resp = self._http.post(
                    "/embeddings",
                    json={"model": self._cfg.embedding_model, "input": list(batch)},
                )
                resp.raise_for_status()
                return resp

            resp = _with_retry(call, what=f"embed {len(batch)} chunk(s)")
            data = resp.json()["data"]
            # The API does not guarantee input order in the response.
            out.extend(item["embedding"] for item in sorted(data, key=lambda d: d["index"]))
        return out

    # --- chat / vision --------------------------------------------------------

    def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.0,
    ) -> str:
        def call() -> httpx.Response:
            resp = self._http.post(
                "/chat/completions",
                json={
                    "model": model or self._cfg.crawl_model,
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
            resp.raise_for_status()
            return resp

        resp = _with_retry(call, what="chat completion")
        return resp.json()["choices"][0]["message"]["content"] or ""

    def describe_image(self, image_bytes: bytes, mime: str, context: str) -> str:
        """Caption a figure so its content is retrievable (plan.md §5).

        The description is embedded alongside the surrounding chunk, which is how a
        question like "what does the cooling infrastructure look like" can reach a
        page whose answer is a photograph.
        """
        b64 = base64.b64encode(image_bytes).decode("ascii")
        return self.complete(
            [
                {
                    "role": "system",
                    "content": (
                        "You describe figures from technical documentation for a search "
                        "index. Write 1-3 factual sentences covering what the figure shows "
                        "and any labels, values or structure visible in it. No preamble, "
                        "no speculation about what is not shown."
                    ),
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"Page context:\n{context[:1500]}"},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{b64}"},
                        },
                    ],
                },
            ],
            max_tokens=300,
        )


def _batched(items: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]
