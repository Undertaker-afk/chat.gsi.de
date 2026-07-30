"""Crawl pipeline: discover -> fetch -> extract -> chunk -> embed -> store."""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .chunk import chunk_markdown
from .config import Config
from .connectors.base import Connector, NotModified, PageRef
from .connectors.foswiki import FoswikiConnector
from .connectors.html_sitemap import HtmlSitemapConnector
from .extract import extract, needs_vision
from .llm_extract import extract_with_llm
from .llm import LLMClient
from .store import CorpusWriter, Database, content_hash
from .vision import apply_vision

log = logging.getLogger(__name__)


class CrawlStopped(Exception):
    """An admin pressed Stop. Raised at a page boundary, never mid-write."""


@dataclass
class RunStats:
    #: The crawl_runs row this counts. Set by crawl_source so a caller can link
    #: the request it claimed to the run it produced -- `getattr(stats,
    #: "run_id", None)` used to be unconditionally None, which quietly left every
    #: crawl_requests.run_id NULL.
    run_id: int | None = None
    seen: int = 0
    changed: int = 0
    skipped: int = 0
    deleted: int = 0
    restricted: int = 0
    failed: int = 0
    #: Pages a changed-only run never requested, because the source's own
    #: revision marker was unchanged since the last crawl. At a 5 s crawl delay
    #: this is the counter that shows the mode paying for itself.
    unfetched: int = 0
    chunks: int = 0
    bytes: int = 0
    #: Counters are bumped from the worker pool. `x += 1` is a read-modify-write
    #: and is not atomic across threads, so it goes through incr().
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def incr(self, name: str, by: int = 1) -> None:
        with self._lock:
            setattr(self, name, getattr(self, name) + by)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {"seen": self.seen, "changed": self.changed, "skipped": self.skipped,
                    "deleted": self.deleted, "restricted": self.restricted,
                    "failed": self.failed, "unfetched": self.unfetched,
                    "chunks": self.chunks, "bytes": self.bytes}


class Controller:
    """Polls crawl_control so Pause and Stop reach a running crawl.

    The web app cannot signal this process, so intent travels through the
    database (migration 018). This class is the read side, and it exists to keep
    two rules in one place:

      * a stop only ever takes effect at a PAGE BOUNDARY, so a document is never
        half-written and chunks never outlive the row they belong to;
      * a stop older than this run's start is ignored. Otherwise a Stop pressed
        while nothing was running would sit in the table and kill the next run
        somebody started, minutes or hours later.

    Polling is throttled to `period` seconds: this is consulted once per page on
    every worker thread, and a query per page would add real load for no gain
    when the answer changes about once a day.
    """

    def __init__(self, db: Any, source_id: int, started_at: datetime, period: float = 5.0):
        self._db = db
        self._source_id = source_id
        self._started_at = started_at
        self._period = period
        self._lock = threading.Lock()
        self._checked_at = 0.0
        self._state: dict[str, Any] = {"desired_state": "running", "stop_requested_at": None}

    def _refresh(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            if now - self._checked_at < self._period:
                return self._state
            self._checked_at = now
        state = self._db.control(self._source_id)
        with self._lock:
            self._state = state
        return state

    def stop_requested(self) -> bool:
        at = self._refresh().get("stop_requested_at")
        return at is not None and at >= self._started_at

    def paused(self) -> bool:
        return self._refresh().get("desired_state") == "paused"

    def checkpoint(self) -> None:
        """Call between pages. Blocks while paused, raises when stopped."""
        if self.stop_requested():
            raise CrawlStopped()
        while self.paused():
            if self.stop_requested():
                raise CrawlStopped()
            # A pause can last a coffee break or a week; sleeping in short
            # slices keeps Stop responsive without busy-waiting.
            time.sleep(2.0)


def _same_moment(a: Any, b: Any) -> bool:
    """Compare two timestamps that may differ in tzinfo awareness.

    Postgres hands back an aware datetime; a sitemap <lastmod> may parse to a
    naive one. Comparing those raises TypeError, and a raised comparison inside
    the change check would be counted as a failed page rather than as "unknown,
    fetch it" -- so anything unclear falls through to a normal fetch.
    """
    try:
        if a.tzinfo is None or b.tzinfo is None:
            return a.replace(tzinfo=None) == b.replace(tzinfo=None)
        return a == b
    except Exception:  # noqa: BLE001
        return False


def build_connector(source: dict[str, Any], cfg: Config) -> Connector:
    kind = source["connector"]
    common = dict(
        slug=source["slug"],
        base_url=source["base_url"],
        config=source["config"] or {},
        user_agent=cfg.user_agent,
        rate_limit_rps=cfg.rate_limit_rps,
    )
    if kind == "foswiki":
        return FoswikiConnector(**common)
    if kind == "html":
        return HtmlSitemapConnector(**common)
    raise NotImplementedError(f"unknown connector: {kind!r}")


#: Modes a run can be started in. `force` and `skip_existing` are still what the
#: pipeline acts on -- mode is the vocabulary the admin UI and the schedule speak,
#: and this is the single place the two are reconciled.
MODES = ("incremental", "changed-only", "full", "skip-existing")


def flags_for(mode: str) -> tuple[bool, bool]:
    """(force, skip_existing) for a mode name."""
    return mode == "full", mode == "skip-existing"


def crawl_source(source: dict[str, Any], cfg: Config, db: Database, llm: LLMClient,
                 *, force: bool = False, skip_existing: bool = False,
                 mode: str = "incremental", requested_by: str | None = None) -> RunStats:
    pageslug = source["slug"]  # ensure slug is always available for logging inside this function
    started_at = datetime.now(timezone.utc)
    run_id = db.start_run(source["id"], force=force, skip_existing=skip_existing,
                          mode=mode, requested_by=requested_by)
    known = db.known_documents(source["id"], run_id)
    # Only loaded for the mode that uses it: for a wiki of a few thousand pages
    # this is a second full-table read that changed-only is the only consumer of.
    revisions = db.known_revisions(source["id"]) if mode == "changed-only" else {}
    lastmods = db.known_last_modified(source["id"]) if mode == "changed-only" else {}
    connector = build_connector(source, cfg)
    corpus = CorpusWriter(cfg.corpus_dir, source["slug"])
    control = Controller(db, source["id"], started_at)

    log.info("[%s] starting crawl (run %d, mode %s, %d known documents, %d with revisions)",
             pageslug, run_id, mode, len(known), len(revisions),
             extra={"kind": "crawl", "event": "start", "source": pageslug,
                    "run_id": run_id, "mode": mode, "known": len(known),
                    "with_revision": len(revisions)})
    stats = RunStats(run_id=run_id)

    # Live progress for the admin UI and the metrics collector. A daemon thread
    # so a crash in the crawl never leaves the process hanging on it, and an
    # Event rather than a sleep loop so shutdown is immediate rather than up to
    # one interval late.
    done = threading.Event()

    def beat() -> None:
        # Database hands out a connection per thread, so this thread gets its own
        # and never interleaves a heartbeat UPDATE with a document write.
        while not done.wait(5.0):
            try:
                db.heartbeat(run_id, stats.snapshot())
            except Exception as exc:  # noqa: BLE001
                # Telemetry must never be able to fail a crawl.
                log.debug("[%s] heartbeat failed: %s", pageslug, exc)

    heart = threading.Thread(target=beat, name=f"heartbeat-{pageslug}", daemon=True)
    heart.start()

    def run_one(ref: PageRef) -> None:
        """One page, on a worker thread. Never raises -- see the handlers below."""
        try:
            _process(ref, source, run_id, connector, cfg, db, llm, corpus, known,
                     stats, skip_existing=skip_existing, revisions=revisions,
                     lastmods=lastmods, mode=mode, control=control)
        except CrawlStopped:
            # Expected: an admin pressed Stop. The discovery loop notices too and
            # ends the run; a worker just stops taking new work.
            pass
        except PermissionError:
            # A restricted topic. Expected on a mixed-visibility wiki and not
            # an error: anonymous access is the ACL boundary, so being turned
            # away is the system working correctly.
            stats.incr("restricted")
            log.debug("[%s] restricted, skipped: %s", pageslug, ref.url)
        except Exception as exc:  # noqa: BLE001 - one bad page must not kill the run
            stats.incr("failed")
            log.warning("[%s] %s failed: %s", pageslug, ref.url, exc,
                        extra={"kind": "crawl", "event": "page_failed",
                               "source": pageslug, "run_id": run_id, "url": ref.url})

    stopped = False
    try:
        log.info("[%s] processing with %d worker(s)", pageslug, cfg.concurrency)
        # Discovery stays on this thread -- it is one cheap request per page for
        # foswiki and a single sitemap read for html, while _process spends ~27 s
        # of every ~28 s waiting on the LLM proxy. Parallelising _process is the
        # whole win; parallelising discovery would only race the rate limiter.
        in_flight: set[Future] = set()
        max_in_flight = cfg.concurrency * 2
        with ThreadPoolExecutor(max_workers=cfg.concurrency,
                                thread_name_prefix=f"crawl-{pageslug}") as pool:
            try:
                for ref in connector.discover():
                    # Pause and Stop are honoured HERE, between pages, and in the
                    # same place in each worker. Discovery is also the only point
                    # where stopping is cheap: no request is in flight and no
                    # document is half-written.
                    control.checkpoint()
                    stats.incr("seen")
                    in_flight.add(pool.submit(run_one, ref))
                    # Bounded queue. Discovery outruns processing by orders of
                    # magnitude, so submitting freely would materialise a future per
                    # page in the whole wiki before the first one finished.
                    if len(in_flight) >= max_in_flight:
                        _, in_flight = wait(in_flight, return_when=FIRST_COMPLETED)
            except CrawlStopped:
                stopped = True
                log.warning("[%s] stop requested -- finishing pages already in flight",
                            pageslug,
                            extra={"kind": "crawl", "event": "stopped",
                                   "source": pageslug, "run_id": run_id})
            wait(in_flight)

        corpus.flush_manifest()

        # Only sweep when discovery actually produced pages AND ran to the end.
        #
        # sweep_deleted() soft-deletes every document this run did not touch and
        # drops its chunks. If discovery fails -- the wiki is unreachable, the web
        # list cannot be read -- it yields nothing, and an unguarded sweep then
        # deletes the entire corpus on the strength of a network error. That has
        # happened once; it cost 145 documents and every chunk in the database.
        # An empty discovery is a failure, not an empty wiki.
        #
        # A STOPPED run is the same hazard wearing a different hat: it saw only
        # the pages discovered before the button was pressed, so every page after
        # that point looks deleted. Pressing Stop must never be able to empty the
        # corpus, so a stopped run never sweeps.
        if stopped:
            log.warning("[%s] stopped -- skipping the delete sweep", pageslug)
        elif stats.seen > 0:
            stats.deleted = db.sweep_deleted(source["id"], run_id)
        else:
            log.error("[%s] discovery returned no pages -- skipping the delete sweep",
                      pageslug)

        if stopped:
            status, error = "stopped", "stopped by an administrator"
        elif stats.seen == 0:
            status, error = "failed", "discovery returned no pages"
        elif stats.failed:
            status, error = "partial", f"{stats.failed} pages failed"
        else:
            status, error = "ok", None

        db.finish_run(run_id, status, seen=stats.seen, changed=stats.changed,
                      deleted=stats.deleted, error=error, stats=stats.snapshot())
        if stopped:
            # Clear the request only once the run has actually wound down, so a
            # stop cannot be acknowledged by a run that never saw it.
            db.acknowledge_stop(source["id"])
    except Exception as exc:  # noqa: BLE001
        db.finish_run(run_id, "failed", seen=stats.seen, changed=stats.changed,
                      deleted=stats.deleted, error=str(exc), stats=stats.snapshot())
        raise
    finally:
        done.set()
        heart.join(timeout=6.0)

    log.info(
        "[%s] done (%s): %d seen, %d changed, %d unchanged, %d not fetched, "
        "%d deleted, %d restricted, %d failed, %d chunks",
        pageslug, status, stats.seen, stats.changed, stats.skipped, stats.unfetched,
        stats.deleted, stats.restricted, stats.failed, stats.chunks,
        extra={"kind": "crawl", "event": "finish", "source": pageslug,
               "run_id": run_id, "mode": mode, "status": status,
               **stats.snapshot()},
    )
    return stats


def _process(ref: PageRef, source: dict[str, Any], run_id: int, connector: Connector,
             cfg: Config, db: Database, llm: LLMClient, corpus: CorpusWriter,
             known: dict[str, str], stats: RunStats, *, skip_existing: bool = False,
             revisions: dict[str, str] | None = None,
             lastmods: dict[str, Any] | None = None, mode: str = "incremental",
             control: "Controller | None" = None) -> None:
    if control is not None:
        control.checkpoint()

    # --skip-existing: anything already indexed is left alone WITHOUT fetching it.
    # That is the whole point -- the normal incremental crawl still costs one
    # request per page to compare hashes, which is hours against a wiki with a
    # 5 s crawl delay. Touch it so the sweep does not mistake it for deleted.
    if skip_existing and ref.url in known:
        db.touch(source["id"], url=ref.url, run_id=run_id)
        stats.incr("skipped")
        return

    # changed-only, step 1: skip the REQUEST entirely when discovery already
    # told us the page is unchanged.
    #
    # Only the sitemap connector can do this, because only a sitemap reports
    # <lastmod> before the page is fetched. When it applies it is the cheapest
    # possible outcome: no request, no crawl-delay, no extraction.
    if mode == "changed-only" and lastmods and ref.last_modified is not None:
        previous = lastmods.get(ref.url)
        if previous is not None and _same_moment(previous, ref.last_modified):
            db.touch(source["id"], url=ref.url, run_id=run_id)
            stats.incr("unfetched")
            return

    # changed-only, step 2: ask conditionally.
    #
    # Foswiki's change feeds are login-gated for guests, so there is nothing to
    # compare before fetching -- but a conditional GET still pays off. The
    # request happens and the crawl delay is still paid; what a 304 saves is LLM
    # extraction, chunking and embedding, and that is ~27 s of the ~28 s a page
    # actually costs.
    #
    # A page with no stored validator falls through to a normal fetch. Absence
    # has to mean "check it", never "assume unchanged" -- getting that backwards
    # would silently freeze the corpus with no error anywhere.
    known_revision = revisions.get(ref.url) if (mode == "changed-only" and revisions) else None

    try:
        raw = connector.fetch(ref, known_revision) if known_revision else connector.fetch(ref)
    except NotModified:
        db.touch(source["id"], url=ref.url, run_id=run_id)
        stats.incr("unfetched")
        return

    stats.incr("bytes", len(raw.html or "") + len(raw.native or ""))

    # LLM-first: the crawl model reads the page and returns clean Markdown. Falls
    # back to deterministic parsing automatically if the proxy is unavailable.
    if cfg.llm_extraction:
        page = extract_with_llm(raw.html or "", raw.url, raw.title, llm)
    else:
        page = extract(raw.html or "", raw.url, raw.title)

    # The page fetched fine, so it still exists. Keep whatever we already have and
    # mark it seen: without the touch, sweep_deleted() would delete a perfectly
    # good document because one extraction attempt came back empty. Observed with
    # the LLM extractor returning EMPTY on a page it had handled on a previous run.
    if not page.markdown.strip():
        log.warning("empty extraction, keeping previous version: %s", raw.url)
        db.touch(source["id"], url=raw.url, run_id=run_id,
                 revision=raw.revision or ref.revision, last_modified=ref.last_modified,
                 discovered_url=ref.url)
        stats.incr("skipped")
        return

    if cfg.vision_enabled and needs_vision(page):
        page = apply_vision(page, llm, connector_ua=cfg.user_agent,
                            allow_hosts=connector.allow_hosts)

    hash_ = content_hash(page.markdown)

    # The whole point of the weekly incremental crawl: unchanged pages cost one
    # fetch and nothing else -- no chunking, no embedding, no writes.
    if known.get(raw.url) == hash_:
        # Unchanged content, but record the validator the server just gave us:
        # this is the page changed-only will want to skip NEXT time, and it will
        # only be able to if we store the validator now.
        db.touch(source["id"], url=raw.url, run_id=run_id,
                 revision=raw.revision or ref.revision, last_modified=ref.last_modified,
                 discovered_url=ref.url)
        stats.incr("skipped")
        return

    chunks = chunk_markdown(
        page.markdown,
        target_tokens=cfg.chunk_target_tokens,
        max_tokens=cfg.chunk_max_tokens,
        section_whole_max=cfg.section_whole_max_tokens,
        overlap_ratio=cfg.chunk_overlap_ratio,
    )
    if not chunks:
        log.warning("no chunks produced, keeping previous version: %s", raw.url)
        db.touch(source["id"], url=raw.url, run_id=run_id,
                 revision=raw.revision or ref.revision, last_modified=ref.last_modified,
                 discovered_url=ref.url)
        stats.incr("skipped")
        return

    # Prepend the heading path so the vector carries its position in the document.
    # Stripped again before anything reaches the chat model.
    embed_inputs = [
        (f"> {' › '.join(c.heading_path)}\n\n{c.text}" if c.heading_path else c.text)
        for c in chunks
    ]
    embeddings = llm.embed_documents(embed_inputs)

    title = page.title or raw.title

    corpus.write(
        url=raw.url, title=title, markdown=page.markdown, hash_=hash_,
        lang=raw.lang, headings=page.headings,
    )
    db.upsert_document(
        source_id=source["id"], run_id=run_id, url=raw.url, title=title,
        markdown=page.markdown, hash_=hash_,
        frontmatter={"headings": page.headings, "revision": raw.revision},
        lang=raw.lang, chunks=chunks, embeddings=embeddings,
        # Stored in its own column, not only in frontmatter: the next
        # changed-only run reads this for every page and a jsonb extraction per
        # row is a needless cost on the one query that has to be quick.
        # Prefer what the fetch reported over what discovery guessed.
        revision=raw.revision or ref.revision,
        last_modified=ref.last_modified,
        # The URL discovery gave us, which is what the NEXT run will look up
        # before it fetches. Differs from raw.url whenever a redirect is involved.
        discovered_url=ref.url,
    )
    stats.incr("changed")
    stats.incr("chunks", len(chunks))
    log.info("indexed %s (%d chunks)", raw.url, len(chunks),
             extra={"kind": "crawl", "event": "indexed", "source": source["slug"],
                    "run_id": run_id, "url": raw.url, "chunks": len(chunks)})
