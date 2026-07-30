"""LLM-first extraction: hand the page to llmbot.qwen3.6-27b and get Markdown back.

Rationale: Foswiki's `?skin=text` output defeats deterministic parsing in several
ways at once -- body copy as bare text nodes between empty <p></p> pairs, %TOC%
macros rendering as repeated self-anchor link lists, no <title> in the fragment,
and preference directives (`Set ALLOWTOPICCHANGE = ...`) inline in the content.
Each is fixable with another heuristic; together they are a maintenance treadmill
that breaks again on the next skin change.

The model reads the page the way a person would and returns clean Markdown. It
costs one cheap call per *changed* page -- unchanged pages never reach this code
because the content hash short-circuits them first.

extract.py remains the fallback for when the proxy is unavailable, so a crawl
degrades rather than fails.
"""

from __future__ import annotations

import logging
import re

from .extract import ExtractedPage, extract as deterministic_extract
from .llm import LLMClient

log = logging.getLogger(__name__)

#: skin=text pages are small (2-9 KB). This bound keeps a pathological page from
#: blowing the 32k context; anything larger falls back to deterministic parsing.
_MAX_HTML_CHARS = 60_000

SYSTEM = """You convert wiki pages into clean Markdown for a documentation search index.

Return ONLY the Markdown. No preamble, no explanation, no code fence around the whole thing.

Rules:
- Start with a single `# ` heading holding the page's real title.
- Keep the heading hierarchy of the source (## for sections, ### for subsections).
- Reproduce tables as real Markdown tables. Reproduce code, commands, paths and config
  snippets in fenced blocks with a language tag where obvious.
- Preserve every command, hostname, path, flag and URL EXACTLY as written. Never
  paraphrase, correct or modernise them — they are the answers people search for.
- Keep links as [text](url), resolving relative URLs against the page URL given below.
- DROP: tables of contents, navigation lists, breadcrumbs, "edit this page" controls,
  attachment/history/backlink footers, and Foswiki preference directives such as
  `Set ALLOWTOPICCHANGE = ...`.
- If the page is a redirect, a login prompt, or has no substantive content, return
  exactly: EMPTY
- Do not invent content that is not on the page."""


def extract_with_llm(
    html: str, url: str, fallback_title: str, llm: LLMClient
) -> ExtractedPage:
    """Convert a page to Markdown with the crawl model, falling back on failure."""
    baseline = deterministic_extract(html, url, fallback_title)

    if not html.strip() or len(html) > _MAX_HTML_CHARS:
        return baseline

    try:
        raw = llm.complete(
            [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Page URL: {url}\n\nHTML:\n\n{html}"},
            ],
            max_tokens=4096,
            temperature=0.0,
        )
    except Exception as exc:  # noqa: BLE001 - never fail a crawl on a model error
        log.warning("llm extraction failed for %s, using deterministic: %s", url, exc)
        return baseline

    markdown = _strip_outer_fence(raw).strip()

    if not markdown or markdown.upper().startswith("EMPTY"):
        # The model is over-eager with EMPTY -- it returned it for real content
        # pages (Linux/LustreFs, Linux/WebHome) that the deterministic parser had
        # no trouble with. Only believe EMPTY when the parser also found little,
        # otherwise a page silently drops out of the corpus.
        if len(baseline.markdown.strip()) > 300:
            log.info("llm said EMPTY but parser found content, using deterministic: %s", url)
            return baseline
        log.debug("llm reported no substantive content: %s", url)
        return ExtractedPage(markdown="", title=fallback_title, images=baseline.images)

    # A model that returns far less than the deterministic parser has probably
    # summarised instead of converting. Trust the parser in that case.
    if len(markdown) < len(baseline.markdown) * 0.4 and len(baseline.markdown) > 500:
        log.warning("llm output suspiciously short for %s, using deterministic", url)
        return baseline

    return ExtractedPage(
        markdown=markdown,
        title=_title_from(markdown) or fallback_title,
        headings=_headings_from(markdown),
        images=baseline.images,
        text_density=baseline.text_density,
    )


def _strip_outer_fence(text: str) -> str:
    """Models often wrap the whole answer in ```markdown ... ``` despite being told not to."""
    stripped = text.strip()
    match = re.match(r"^```(?:markdown|md)?\s*\n(.*)\n```$", stripped, re.S)
    return match.group(1) if match else stripped


def _title_from(markdown: str) -> str | None:
    match = re.search(r"^#\s+(.+)$", markdown, re.M)
    return match.group(1).strip() if match else None


def _headings_from(markdown: str) -> list[str]:
    # Skip fenced blocks so a '# comment' inside shell code is not read as a heading.
    body = re.sub(r"```.*?```", "", markdown, flags=re.S)
    return [m.group(2).strip() for m in re.finditer(r"^(#{1,6})\s+(.+)$", body, re.M)]
