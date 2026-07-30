"""Vision-assisted extraction with llmbot.qwen3.6-27b.

Only invoked where deterministic extraction is untrustworthy (extract.needs_vision).
Captions are written into the Markdown as HTML comments beside the image, so they
are embedded with the surrounding chunk but stay invisible when the Markdown is
rendered.
"""

from __future__ import annotations

import logging

import httpx

from .extract import ExtractedPage
from .llm import LLMClient
from .scope import DEFAULT_ALLOWED_HOSTS, in_scope

log = logging.getLogger(__name__)

_MAX_IMAGE_BYTES = 6 * 1024 * 1024
_MAX_IMAGES_PER_PAGE = 6   # a gallery page must not cost 200 vision calls
_SUPPORTED = ("image/png", "image/jpeg", "image/webp", "image/gif")


def apply_vision(page: ExtractedPage, llm: LLMClient, *, connector_ua: str,
                 allow_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS) -> ExtractedPage:
    markdown = page.markdown
    described = 0

    with httpx.Client(headers={"User-Agent": connector_ua}, timeout=30.0,
                      follow_redirects=True) as http:
        for image in page.images:
            if described >= _MAX_IMAGES_PER_PAGE:
                break
            # An informative alt text already does the job; don't pay for a call.
            if len(image.alt.strip()) >= 8:
                markdown = markdown.replace(image.placeholder, "")
                continue

            caption = _describe(http, llm, image.src, page.markdown, allow_hosts)
            if caption:
                comment = "<!-- vision: " + caption.replace("--", "-").strip() + " -->"
                markdown = markdown.replace(image.placeholder, comment)
                described += 1
            else:
                markdown = markdown.replace(image.placeholder, "")

    # Drop any placeholders left over from the per-page cap.
    for image in page.images:
        markdown = markdown.replace(image.placeholder, "")

    if described:
        log.info("described %d figure(s)", described)

    page.markdown = markdown
    return page


def _describe(http: httpx.Client, llm: LLMClient, src: str, context: str,
              allow_hosts: tuple[str, ...]) -> str | None:
    # A page can embed an image from anywhere, so this is a crawl target like any
    # other and gets the same boundary. Without it the vision pass walked off
    # gsi.de onto SourceForge mirrors -- see app/scope.py.
    if not in_scope(src, allow_hosts):
        log.debug("out of scope, not fetching image %s", src)
        return None

    try:
        # Streamed with a hard byte cap. The previous version read resp.content in
        # full and only then compared it against the cap, so an oversized body was
        # already downloaded by the time it was rejected -- which is how a mirror
        # redirect chain turned into real download traffic.
        with http.stream("GET", src) as resp:
            resp.raise_for_status()

            if not in_scope(str(resp.url), allow_hosts):
                log.debug("image redirected out of scope: %s -> %s", src, resp.url)
                return None

            mime = resp.headers.get("content-type", "").split(";")[0].strip()
            if mime not in _SUPPORTED:
                return None

            declared = resp.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > _MAX_IMAGE_BYTES:
                return None

            body = bytearray()
            for chunk in resp.iter_bytes():
                body.extend(chunk)
                if len(body) > _MAX_IMAGE_BYTES:
                    log.debug("image over %d bytes, abandoning %s", _MAX_IMAGE_BYTES, src)
                    return None
    except Exception as exc:  # noqa: BLE001
        log.debug("image fetch failed %s: %s", src, exc)
        return None

    try:
        return llm.describe_image(bytes(body), mime, context).strip() or None
    except Exception as exc:  # noqa: BLE001 - a failed caption must not fail the page
        log.warning("vision call failed for %s: %s", src, exc)
        return None
