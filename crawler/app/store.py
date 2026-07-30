"""Persistence: Markdown corpus on disk + Postgres/pgvector."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlparse, urlsplit

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .chunk import Chunk

log = logging.getLogger(__name__)


def content_hash(markdown: str) -> str:
    """Hash of normalised content -- the incremental-crawl oracle.

    Whitespace is collapsed so that cosmetic reflows in the wiki do not trigger a
    needless re-embed of an otherwise unchanged page.
    """
    normalised = re.sub(r"\s+", " ", markdown).strip()
    return "sha256:" + hashlib.sha256(normalised.encode("utf-8")).hexdigest()


# --- corpus on disk -----------------------------------------------------------


class CorpusWriter:
    """Writes the Markdown corpus: one file per page plus a manifest.

    Kept deliberately human-readable and diffable -- `git diff` over data/corpus
    is the fastest way to see what a weekly recrawl actually changed.
    """

    def __init__(self, root: Path, source_slug: str) -> None:
        self.dir = root / source_slug
        self.dir.mkdir(parents=True, exist_ok=True)
        self._manifest: dict[str, dict[str, Any]] = {}
        # write() runs on the worker pool. Distinct URLs always hash to distinct
        # filenames so the file writes never collide, but the manifest is shared.
        self._lock = threading.Lock()

    def write(self, *, url: str, title: str, markdown: str, hash_: str,
              lang: str | None, headings: Sequence[str]) -> Path:
        path = self.dir / f"{self._slug(url)}.md"
        frontmatter = {
            "url": url,
            "title": title,
            "source": self.dir.name,
            "crawled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "content_hash": hash_,
            "lang": lang,
            "headings": list(headings),
        }
        path.write_text(self._frontmatter(frontmatter) + "\n" + markdown + "\n", encoding="utf-8")
        with self._lock:
            self._manifest[url] = {**frontmatter, "path": path.name}
        return path

    def _frontmatter(self, data: dict[str, Any]) -> str:
        lines = ["---"]
        for key, value in data.items():
            if value is None:
                continue
            lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}"
                         if isinstance(value, (list, dict)) else f"{key}: {value}")
        lines.append("---")
        return "\n".join(lines)

    def _slug(self, url: str) -> str:
        parsed = urlparse(url)
        raw = (parsed.path.strip("/") or "index")
        if parsed.query:
            raw += "_" + hashlib.sha1(parsed.query.encode()).hexdigest()[:8]
        slug = re.sub(r"[^\w.-]+", "-", raw).strip("-").lower()[:120]
        # Guarantee uniqueness: distinct URLs must never collide onto one file.
        return f"{slug or 'page'}-{hashlib.sha1(url.encode()).hexdigest()[:8]}"

    def flush_manifest(self) -> None:
        with self._lock:
            documents = list(self._manifest.values())
        (self.dir / "manifest.json").write_text(
            json.dumps(
                {
                    "source": self.dir.name,
                    "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "pages": len(documents),
                    "documents": documents,
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )


# --- database -----------------------------------------------------------------


class Database:
    """Postgres access, one connection per thread.

    The worker pool means several threads call upsert_document concurrently, and
    a single shared connection cannot serve that: every method here ends in an
    explicit commit(), and on a shared connection one thread's commit would
    commit another thread's half-finished work -- silently, since psycopg
    serialises the statements themselves and nothing would raise. Giving each
    thread its own connection keeps one transaction per document, which is what
    the commit boundaries in these methods already assume.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._local = threading.local()
        self._open: list[psycopg.Connection] = []
        self._open_lock = threading.Lock()
        # Fail fast on a bad DSN rather than on the first worker's first query.
        self._connect()

    def _connect(self) -> psycopg.Connection:
        conn = psycopg.connect(self._dsn, row_factory=dict_row, autocommit=False)
        self._local.conn = conn
        with self._open_lock:
            self._open.append(conn)
        return conn

    @property
    def _conn(self) -> psycopg.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None or conn.closed:
            conn = self._connect()
        return conn

    def close(self) -> None:
        with self._open_lock:
            for conn in self._open:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001 - closing must not mask a real error
                    log.debug("connection close failed", exc_info=True)
            self._open.clear()
        self._local = threading.local()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def sources(self, slug: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM sources WHERE enabled ORDER BY id"
        params: tuple = ()
        if slug:
            sql = "SELECT * FROM sources WHERE slug = %s"
            params = (slug,)
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        self._conn.commit()
        return rows

    def start_run(self, source_id: int, *, force: bool = False,
                  skip_existing: bool = False, mode: str = "incremental",
                  requested_by: str | None = None) -> int:
        """Open a run, recording the flags it was started with.

        Stored rather than merely logged: "why did this run change nothing?" is
        the first question about any crawl, and the mode answers it.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                "INSERT INTO crawl_runs (source_id, force, skip_existing, mode, "
                "                        requested_by, heartbeat_at) "
                "VALUES (%s, %s, %s, %s, %s, now()) RETURNING id",
                (source_id, force, skip_existing, mode, requested_by),
            )
            run_id = cur.fetchone()["id"]
        self._conn.commit()
        return run_id

    def heartbeat(self, run_id: int, stats: dict[str, int]) -> None:
        """Publish live progress for the admin UI and the metrics collector.

        A crawl of the wiki legitimately runs for hours, so "started long ago"
        proves nothing about health. A heartbeat does: a run whose heartbeat has
        gone stale is stuck or dead, and one whose counters are still climbing is
        merely slow. The admin page draws its progress bar from this.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                """UPDATE crawl_runs
                      SET heartbeat_at = now(), pages_seen = %s, pages_changed = %s,
                          pages_skipped = %s, pages_restricted = %s, pages_failed = %s,
                          pages_unfetched = %s, chunks_written = %s, bytes_fetched = %s
                    WHERE id = %s""",
                (stats.get("seen", 0), stats.get("changed", 0), stats.get("skipped", 0),
                 stats.get("restricted", 0), stats.get("failed", 0),
                 stats.get("unfetched", 0), stats.get("chunks", 0),
                 stats.get("bytes", 0), run_id),
            )
        self._conn.commit()

    def finish_run(self, run_id: int, status: str, *, seen: int, changed: int,
                   deleted: int, error: str | None = None,
                   stats: dict[str, int] | None = None) -> None:
        extra = stats or {}
        with self._conn.cursor() as cur:
            cur.execute(
                """UPDATE crawl_runs
                      SET finished_at = now(), heartbeat_at = now(), status = %s,
                          pages_seen = %s, pages_changed = %s, pages_deleted = %s,
                          pages_skipped = %s, pages_restricted = %s, pages_failed = %s,
                          pages_unfetched = %s, chunks_written = %s, bytes_fetched = %s,
                          error = %s
                    WHERE id = %s""",
                (status, seen, changed, deleted,
                 extra.get("skipped", 0), extra.get("restricted", 0), extra.get("failed", 0),
                 extra.get("unfetched", 0), extra.get("chunks", 0), extra.get("bytes", 0),
                 error, run_id),
            )
        self._conn.commit()

    def known_hashes(self, source_id: int) -> dict[str, str]:
        with self._conn.cursor() as cur:
            cur.execute(
                "SELECT url, content_hash FROM documents "
                "WHERE source_id = %s AND deleted_at IS NULL",
                (source_id,),
            )
            rows = cur.fetchall()
        self._conn.commit()
        return {r["url"]: r["content_hash"] for r in rows}

    def claim_crawl_requests(self) -> list[dict[str, Any]]:
        """Take every pending crawl request, atomically.

        The UPDATE ... RETURNING is the claim: two crawlers running at once
        cannot both take the same request, so a stuck timer firing twice does
        not double-crawl the wiki.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                """UPDATE crawl_requests q
                      SET started_at = now()
                    WHERE q.started_at IS NULL AND q.cancelled_at IS NULL
                RETURNING q.id, q.source_id, q.force, q.skip_existing, q.mode,
                          q.requested_by"""
            )
            rows = cur.fetchall()
        self._conn.commit()
        return rows

    def finish_crawl_request(self, request_id: int, run_id: int | None) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE crawl_requests SET run_id = %s, finished_at = now() WHERE id = %s",
                (run_id, request_id),
            )
        self._conn.commit()

    # --- control plane (migration 018) ---------------------------------------
    #
    # The frontend cannot signal this process: it is a separate image the web app
    # has no handle on, and giving a web app a socket into the container runtime
    # is a large hole for a small button (see 011). So control is a table. The
    # running crawl polls it at page boundaries, which is the only place where
    # stopping is safe -- see stop handling in pipeline.py.

    def control(self, source_id: int) -> dict[str, Any]:
        """Current desired state for a source. Always returns a row."""
        with self._conn.cursor() as cur:
            cur.execute(
                """SELECT desired_state, stop_requested_at, stop_requested_by,
                          interval_minutes, mode, next_run_at
                     FROM crawl_control WHERE source_id = %s""",
                (source_id,),
            )
            row = cur.fetchone()
            if row is None:
                # A source added after 018 ran. Create the row rather than
                # special-casing its absence in every caller.
                cur.execute(
                    "INSERT INTO crawl_control (source_id) VALUES (%s) "
                    "ON CONFLICT (source_id) DO NOTHING", (source_id,))
                self._conn.commit()
                return {"desired_state": "running", "stop_requested_at": None,
                        "stop_requested_by": None, "interval_minutes": None,
                        "mode": "changed-only", "next_run_at": None}
        self._conn.commit()
        return row

    def acknowledge_stop(self, source_id: int) -> None:
        """Clear a stop once the run has actually wound down.

        Cleared by the crawler, never by the UI: if the button cleared it, a stop
        pressed while nothing was running would be silently lost, and an admin
        would have no way to tell that from a stop that worked.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE crawl_control SET stop_requested_at = NULL, "
                "       stop_requested_by = NULL, desired_state = 'running' "
                " WHERE source_id = %s", (source_id,))
        self._conn.commit()

    def due_schedules(self) -> list[dict[str, Any]]:
        """Sources whose automatic interval has come round.

        Paused sources are excluded here rather than filtered later, so a pause
        genuinely prevents work instead of merely hiding it. A source with a run
        already in flight is excluded too: a crawl that takes longer than its own
        interval must not stack up behind itself.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                """SELECT c.source_id, c.mode, c.interval_minutes
                     FROM crawl_control c
                     JOIN sources s ON s.id = c.source_id AND s.enabled
                    WHERE c.interval_minutes IS NOT NULL
                      AND c.desired_state = 'running'
                      AND (c.next_run_at IS NULL OR c.next_run_at <= now())
                      AND NOT EXISTS (SELECT 1 FROM crawl_runs r
                                       WHERE r.source_id = c.source_id
                                         AND r.status = 'running')
                      AND NOT EXISTS (SELECT 1 FROM crawl_requests q
                                       WHERE q.source_id = c.source_id
                                         AND q.started_at IS NULL
                                         AND q.cancelled_at IS NULL)""")
            rows = cur.fetchall()
        self._conn.commit()
        return rows

    def schedule_next(self, source_id: int) -> None:
        """Advance next_run_at by one interval, from NOW rather than from the
        previous due time. Catching up on missed intervals after a week of
        downtime would mean N back-to-back crawls of the same wiki."""
        with self._conn.cursor() as cur:
            cur.execute(
                """UPDATE crawl_control
                      SET next_run_at = now() + make_interval(mins => interval_minutes)
                    WHERE source_id = %s AND interval_minutes IS NOT NULL""",
                (source_id,))
        self._conn.commit()

    def enqueue_request(self, source_id: int, *, mode: str, requested_by: str) -> int:
        with self._conn.cursor() as cur:
            cur.execute(
                """INSERT INTO crawl_requests (source_id, requested_by, mode, force,
                                               skip_existing)
                   VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                (source_id, requested_by, mode, mode == "full", mode == "skip-existing"))
            request_id = cur.fetchone()["id"]
        self._conn.commit()
        return request_id

    def stale_running_runs(self, older_than_seconds: int = 900) -> int:
        """Close out runs whose crawler died without finishing them.

        A killed pod leaves status='running' forever, which would block every
        future scheduled crawl of that source (see due_schedules) and show a
        permanently in-progress bar in the admin UI. Marked 'failed', not
        'stopped': nobody asked for this one to end.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                """UPDATE crawl_runs
                      SET status = 'failed', finished_at = now(),
                          error = 'crawler died: no heartbeat for over %s seconds'
                    WHERE status = 'running'
                      AND coalesce(heartbeat_at, started_at) < now() - make_interval(secs => %s)
                RETURNING id""",
                (older_than_seconds, older_than_seconds))
            n = len(cur.fetchall())
        self._conn.commit()
        return n

    def source_by_id(self, source_id: int) -> dict[str, Any] | None:
        with self._conn.cursor() as cur:
            cur.execute("SELECT * FROM sources WHERE id = %s", (source_id,))
            row = cur.fetchone()
        self._conn.commit()
        return row

    def known_documents(self, source_id: int, run_id: int) -> dict[str, str]:
        """url -> content hash for everything already indexed for this source.

        The incremental crawl compares hashes with it; --skip-existing only
        checks membership, and never fetches a page it already has.
        """
        return self.known_hashes(source_id)

    def known_revisions(self, source_id: int) -> dict[str, str]:
        """url -> the source's own revision marker, for changed-only crawls.

        Separate from known_hashes because the two answer different questions at
        different costs. A content hash needs the page body, so comparing it
        still costs a fetch -- hours, against a wiki with a 5 s crawl delay. A
        revision marker comes back from discovery, so comparing it costs
        nothing, and a page whose revision is unchanged is never requested at
        all. Rows with no stored revision are omitted: absence has to mean
        "fetch it", never "assume unchanged".
        """
        with self._conn.cursor() as cur:
            cur.execute(
                "SELECT coalesce(discovered_url, url) AS key, revision FROM documents "
                " WHERE source_id = %s AND deleted_at IS NULL AND revision IS NOT NULL",
                (source_id,),
            )
            rows = cur.fetchall()
        self._conn.commit()
        return {r["key"]: r["revision"] for r in rows}

    def known_last_modified(self, source_id: int) -> dict[str, Any]:
        """url -> the Last-Modified discovery reported last time.

        Separate from known_revisions because it answers a cheaper question: a
        sitemap carries <lastmod> for every URL, so this comparison happens
        BEFORE any request is made. The revision map only helps once a request
        is already in flight.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                "SELECT coalesce(discovered_url, url) AS key, last_modified FROM documents "
                " WHERE source_id = %s AND deleted_at IS NULL AND last_modified IS NOT NULL",
                (source_id,),
            )
            rows = cur.fetchall()
        self._conn.commit()
        return {r["key"]: r["last_modified"] for r in rows}

    def touch(self, source_id: int, url: str, run_id: int,
              revision: str | None = None, last_modified: Any = None,
              discovered_url: str | None = None) -> None:
        """Mark an unchanged document as still present, without re-embedding.

        The validators are refreshed here as well as on a real write, and that is
        load-bearing rather than tidy: a page that never changes is never
        upserted, so if only upsert_document recorded them, the pages that
        changed-only exists to skip would be exactly the pages that never get a
        validator -- and the mode would stay at zero savings forever. Measured:
        two consecutive changed-only runs skipped nothing until this was added.

        COALESCE, not assignment: a fetch that returns no validator must not
        erase the one we already had.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                """UPDATE documents
                      SET last_seen_run  = %s,
                          revision       = coalesce(%s, revision),
                          last_modified  = coalesce(%s, last_modified),
                          discovered_url = coalesce(%s, discovered_url)
                    WHERE source_id = %s AND url = %s""",
                (run_id, revision, last_modified, discovered_url, source_id, url),
            )
        self._conn.commit()

    def knowledge_base_for(self, source_id: int, url: str) -> int | None:
        """Which knowledge base a page belongs to (see db/migrations/008, 009).

        Foswiki keeps one web per first path segment, and that web is the unit
        access is granted on -- so a new web discovered mid-crawl gets its own
        knowledge base here, starting private: nobody can reach it until an admin
        grants it to a group. Other connectors are one knowledge base per source.
        """
        with self._conn.cursor() as cur:
            cur.execute("SELECT slug, connector FROM sources WHERE id = %s", (source_id,))
            source = cur.fetchone()
            if source is None:
                return None

            web: str | None = None
            if source["connector"] == "foswiki":
                path = urlsplit(url).path.lstrip("/")
                web = path.split("/", 1)[0] or None
                if web is None:
                    return None

            slug = f"{source['slug']}:{web}" if web else source["slug"]
            cur.execute(
                """INSERT INTO knowledge_bases (source_id, web, slug, label)
                        VALUES (%s, %s, %s, %s)
                   ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
                     RETURNING id""",
                (source_id, web, slug, web or source["slug"]),
            )
            return cur.fetchone()["id"]

    def upsert_document(
        self,
        *,
        source_id: int,
        run_id: int,
        url: str,
        title: str,
        markdown: str,
        hash_: str,
        frontmatter: dict[str, Any],
        lang: str | None,
        chunks: list[Chunk],
        embeddings: list[list[float]],
        revision: str | None = None,
        last_modified: Any = None,
        discovered_url: str | None = None,
    ) -> int:
        """Replace a document and all its chunks atomically.

        Chunks are deleted and reinserted rather than diffed: ordinals shift when a
        page is edited, so a diff would be more code for no benefit at this scale.
        """
        if len(chunks) != len(embeddings):
            raise ValueError(f"chunk/embedding mismatch: {len(chunks)} vs {len(embeddings)}")

        kb_id = self.knowledge_base_for(source_id, url)

        with self._conn.cursor() as cur:
            cur.execute(
                """INSERT INTO documents
                       (source_id, url, title, content_hash, markdown, frontmatter,
                        lang, last_seen_run, fetched_at, deleted_at, kb_id,
                        revision, last_modified, discovered_url)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), NULL, %s, %s, %s, %s)
                   ON CONFLICT (source_id, url) DO UPDATE SET
                       title = EXCLUDED.title,
                       content_hash = EXCLUDED.content_hash,
                       markdown = EXCLUDED.markdown,
                       frontmatter = EXCLUDED.frontmatter,
                       lang = EXCLUDED.lang,
                       last_seen_run = EXCLUDED.last_seen_run,
                       fetched_at = now(),
                       deleted_at = NULL,
                       kb_id = EXCLUDED.kb_id,
                       revision = EXCLUDED.revision,
                       last_modified = EXCLUDED.last_modified,
                       discovered_url = EXCLUDED.discovered_url
                   RETURNING id""",
                (source_id, url, title, hash_, markdown, Jsonb(frontmatter), lang, run_id,
                 kb_id, revision, last_modified, discovered_url),
            )
            document_id = cur.fetchone()["id"]

            cur.execute("DELETE FROM chunks WHERE document_id = %s", (document_id,))
            cur.executemany(
                """INSERT INTO chunks
                       (document_id, ordinal, heading_path, anchor, text, token_count, embedding)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                [
                    (document_id, c.ordinal, c.heading_path, c.anchor, c.text,
                     c.token_count, _vector(emb))
                    for c, emb in zip(chunks, embeddings)
                ],
            )
        self._conn.commit()
        return document_id

    def undelete_all(self, source_id: int) -> int:
        """Bring back soft-deleted documents. Chunks are NOT restored by this --
        they were dropped by the sweep and have to be rebuilt from the markdown
        (see `reindex`)."""
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET deleted_at = NULL "
                " WHERE source_id = %s AND deleted_at IS NOT NULL RETURNING id",
                (source_id,),
            )
            n = len(cur.fetchall())
        self._conn.commit()
        return n

    def documents_without_chunks(self, source_id: int) -> list[dict[str, Any]]:
        """Live documents whose chunks are missing -- what `reindex` has to fix."""
        with self._conn.cursor() as cur:
            cur.execute(
                """SELECT d.id, d.url, d.title, d.markdown
                     FROM documents d
                    WHERE d.source_id = %s AND d.deleted_at IS NULL
                      AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
                 ORDER BY d.id""",
                (source_id,),
            )
            rows = cur.fetchall()
        self._conn.commit()
        return rows

    def replace_chunks(self, document_id: int, chunks: list[Chunk],
                       embeddings: list[list[float]]) -> None:
        """Rewrite one document's chunks without touching the document itself."""
        with self._conn.cursor() as cur:
            cur.execute("DELETE FROM chunks WHERE document_id = %s", (document_id,))
            cur.executemany(
                """INSERT INTO chunks
                       (document_id, ordinal, heading_path, anchor, text, token_count, embedding)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                [
                    (document_id, c.ordinal, c.heading_path, c.anchor, c.text,
                     c.token_count, _vector(emb))
                    for c, emb in zip(chunks, embeddings)
                ],
            )
        self._conn.commit()

    def sweep_deleted(self, source_id: int, run_id: int) -> int:
        """Soft-delete documents the crawl no longer found, and drop their chunks.

        Without this, a page removed from the wiki keeps being cited forever.
        """
        with self._conn.cursor() as cur:
            cur.execute(
                """UPDATE documents SET deleted_at = now()
                    WHERE source_id = %s AND deleted_at IS NULL
                      AND (last_seen_run IS DISTINCT FROM %s)
                RETURNING id""",
                (source_id, run_id),
            )
            ids = [r["id"] for r in cur.fetchall()]
            if ids:
                cur.execute("DELETE FROM chunks WHERE document_id = ANY(%s)", (ids,))
        self._conn.commit()
        return len(ids)


def _vector(values: list[float]) -> str:
    """pgvector literal. psycopg has no native adapter without pgvector-python."""
    return "[" + ",".join(f"{v:.7g}" for v in values) + "]"
