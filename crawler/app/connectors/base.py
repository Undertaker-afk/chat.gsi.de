"""Connector interface.

The wiki engine behind wiki.gsi.de is not yet confirmed (plan.md §12). This interface
is what keeps that a one-file decision: HtmlSitemapConnector works against anything,
and a MediaWiki/DokuWiki/BookStack connector can replace it without touching the
pipeline, the schema, or the frontend.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Protocol, runtime_checkable


def _conditional_headers(known_revision: str | None) -> dict[str, str]:
    """Turn a stored validator into the right conditional request header.

    We store whatever the server gave us last time, which is an ETag for some
    pages and a Last-Modified date for others. They are not interchangeable:
    sending a date as If-None-Match makes the server compare it against an ETag
    and always answer 200, which looks like "everything changed" and silently
    disables the whole optimisation. ETags are quoted or start with W/; HTTP
    dates are not.

    The `-gzip` dance is not paranoia, it is virgo-docs.hpc.gsi.de. Apache's
    mod_deflate appends "-gzip" to the ETag when it compresses a response, but it
    does so AFTER evaluating If-None-Match -- so a client that faithfully echoes
    back the ETag it was given never matches, and the server answers 200 forever.
    Measured here: four consecutive changed-only runs skipped exactly zero pages
    because of it. If-None-Match takes a LIST, so sending both the stored form
    and the suffix-stripped form is spec-compliant and matches whichever one the
    server actually compares against.
    """
    if not known_revision:
        return {}
    value = known_revision.strip()
    if value.startswith(('"', "W/")):
        candidates = [value]
        stripped = _strip_gzip_suffix(value)
        if stripped != value:
            candidates.append(stripped)
        return {"If-None-Match": ", ".join(candidates)}
    return {"If-Modified-Since": value}


def _strip_gzip_suffix(etag: str) -> str:
    """`"abc-gzip"` -> `"abc"`. Leaves anything else alone."""
    if etag.endswith('-gzip"'):
        return etag[: -len('-gzip"')] + '"'
    return etag


class NotModified(Exception):
    """The source says this page has not changed since `known_revision`.

    Raised by a connector's fetch() when a conditional request comes back 304.
    That answer costs one request and no body, and -- far more importantly -- it
    skips LLM extraction, chunking and embedding, which is ~27 s of the ~28 s a
    page actually costs. Distinct from returning an empty page, which means the
    fetch worked and produced nothing useful.
    """


@dataclass(frozen=True)
class PageRef:
    """A page we know exists, before fetching it."""

    url: str
    #: Source-side revision marker (MediaWiki revid, ETag, Last-Modified...).
    #: When present and unchanged since the last run, the fetch can be skipped
    #: entirely -- cheaper even than the content-hash check.
    revision: str | None = None
    last_modified: datetime | None = None


@dataclass
class RawPage:
    """A fetched page, before extraction."""

    url: str
    title: str
    html: str | None = None
    #: Source-native markup (wikitext, DokuWiki syntax) when the connector can get
    #: it. Preferred over HTML: no navigation chrome to strip.
    native: str | None = None
    native_format: str | None = None
    lang: str | None = None
    revision: str | None = None
    fetched_at: datetime | None = None
    extra: dict = field(default_factory=dict)


@runtime_checkable
class Connector(Protocol):
    slug: str

    def discover(self) -> Iterable[PageRef]:
        """Every page currently in scope for this source."""

    def fetch(self, ref: PageRef, known_revision: str | None = None) -> RawPage:
        """Retrieve one page.

        `known_revision` is what the last crawl stored for this URL. A connector
        that can make a conditional request should send it (If-None-Match, or
        If-Modified-Since when it looks like a date) and raise NotModified on a
        304. Ignoring it is always correct, just slower.
        """

    def supports_incremental(self) -> bool:
        """True if the source can answer 'what changed since T?' directly."""

    def changed_since(self, since: datetime) -> Iterable[PageRef]:
        """Pages changed since `since`. Only called when supports_incremental()."""
