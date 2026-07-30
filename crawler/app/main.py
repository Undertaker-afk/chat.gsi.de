"""Crawler CLI.

    python -m app.main crawl [--source wiki] [--force] [--skip-existing]
    python -m app.main reindex [--source wiki] [--undelete]
    python -m app.main status
    python -m app.main check          # verify proxy reachability + embedding dims
"""

from __future__ import annotations

import argparse
import logging
import sys

from .chunk import chunk_markdown
from .config import Config
from .llm import LLMClient
from .log import configure as configure_logging
from .pipeline import MODES, crawl_source, flags_for
from .store import Database


MARKER = "🔷"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="crawler")
    sub = parser.add_subparsers(dest="command", required=True)

    crawl = sub.add_parser("crawl", help="crawl and index sources")
    crawl.add_argument("--source", help="source slug (default: all enabled)")
    crawl.add_argument("--force", action="store_true",
                       help="re-embed everything, ignoring content hashes")
    crawl.add_argument("--requested", action="store_true",
                       help="crawl only what the admin UI has queued (see migration 011)")
    crawl.add_argument("--skip-existing", action="store_true",
                       help="Skip pages that already exist in the database (do not fetch/re-index unchanged content)")
    crawl.add_argument("--mode", choices=MODES, default=None,
                       help="incremental (default) | changed-only | full | skip-existing. "
                            "changed-only skips the FETCH for pages whose source-side "
                            "revision is unchanged, so an unmodified page costs nothing.")

    tick = sub.add_parser(
        "tick",
        help="run whatever is due: queued admin requests plus expired intervals")
    tick.add_argument("--once", action="store_true",
                      help="(default) do one pass and exit; the timer provides the loop")

    reindex = sub.add_parser(
        "reindex",
        help="rebuild chunks and embeddings from the markdown already in the database")
    reindex.add_argument("--source", help="source slug (default: all enabled)")
    reindex.add_argument("--undelete", action="store_true",
                         help="also bring back soft-deleted documents first")

    sub.add_parser("status", help="show recent crawl runs")
    sub.add_parser("check", help="verify the LLM proxy and embedding dimensions")

    args = parser.parse_args(argv)
    configure_logging()

    cfg = Config.from_env()

    if args.command == "check":
        return _check(cfg)
    if args.command == "status":
        return _status(cfg)
    if args.command == "reindex":
        return _reindex(cfg, args.source, args.undelete)
    if args.command == "tick":
        return _tick(cfg)
    if args.requested:
        # Superseded by `tick`, which also honours the per-source intervals from
        # migration 018. Kept so the existing systemd unit keeps working.
        return _tick(cfg)
    # --mode is the newer spelling; --force/--skip-existing still work and win
    # when given, so existing Makefile targets and the systemd unit are unchanged.
    mode = args.mode or ("full" if args.force
                         else "skip-existing" if args.skip_existing
                         else "incremental")
    return _crawl(cfg, args.source, mode)


def _crawl(cfg: Config, slug: str | None, mode: str) -> int:
    force, skip_existing = flags_for(mode)
    with Database(cfg.database_url) as db, LLMClient(cfg) as llm:
        sources = db.sources(slug)
        if not sources:
            print(f"no enabled source matching {slug!r}", file=sys.stderr)
            return 1
        failed = False
        for source in sources:
            try:
                crawl_source(source, cfg, db, llm, force=force,
                             skip_existing=skip_existing, mode=mode, requested_by="cli")
            except Exception as exc:  # noqa: BLE001
                logging.error("source %s failed: %s", source["slug"], exc)
                failed = True
    return 1 if failed else 0


def _tick(cfg: Config) -> int:
    """One scheduler pass. Meant for a short timer (every 5 minutes).

    This is what makes the crawl interval an admin setting instead of a systemd
    unit on somebody's laptop: the timer fires constantly and does nothing, and
    the DATABASE decides when a crawl is actually due (migration 018).

    Order matters. Stale runs are reaped first, because a run left behind by a
    killed pod stays `running` forever and would block every future scheduled
    crawl of that source. Then queued admin requests, which a human is waiting
    on. Then expired intervals.
    """
    with Database(cfg.database_url) as db, LLMClient(cfg) as llm:
        reaped = db.stale_running_runs()
        if reaped:
            logging.warning("reaped %d run(s) with no heartbeat", reaped)

        worked = False
        failed = False

        for req in db.claim_crawl_requests():
            source = db.source_by_id(req["source_id"])
            if source is None:
                db.finish_crawl_request(req["id"], None)
                continue
            mode = req.get("mode") or "incremental"
            force, skip_existing = flags_for(mode)
            worked = True
            logging.info("claimed request %d: %s (%s)", req["id"], source["slug"], mode)
            try:
                stats = crawl_source(source, cfg, db, llm, force=force,
                                     skip_existing=skip_existing, mode=mode,
                                     requested_by=req.get("requested_by"))
                db.finish_crawl_request(req["id"], getattr(stats, "run_id", None))
            except Exception as exc:  # noqa: BLE001
                logging.error("requested crawl of %s failed: %s", source["slug"], exc)
                db.finish_crawl_request(req["id"], None)
                failed = True

        for due in db.due_schedules():
            source = db.source_by_id(due["source_id"])
            if source is None:
                continue
            mode = due.get("mode") or "changed-only"
            force, skip_existing = flags_for(mode)
            worked = True
            logging.info("scheduled crawl due: %s (%s, every %s min)",
                         source["slug"], mode, due["interval_minutes"])
            # Advance the schedule BEFORE crawling. A crawl that takes longer
            # than its own interval would otherwise be immediately due again the
            # moment it finished, and the wiki would be crawled continuously.
            db.schedule_next(due["source_id"])
            try:
                crawl_source(source, cfg, db, llm, force=force,
                             skip_existing=skip_existing, mode=mode,
                             requested_by="schedule")
            except Exception as exc:  # noqa: BLE001
                logging.error("scheduled crawl of %s failed: %s", source["slug"], exc)
                failed = True

        if not worked:
            logging.debug("nothing due")
    return 1 if failed else 0


def _reindex(cfg: Config, slug: str | None, undelete: bool) -> int:
    """Rebuild chunks from stored markdown -- no network, no wiki access.

    The document text is already in the database, so a lost or corrupted chunk
    table costs embeddings and nothing else. That makes recovery from a bad
    sweep a local operation rather than a full re-crawl against a wiki with a
    5 s crawl delay.
    """
    with Database(cfg.database_url) as db, LLMClient(cfg) as llm:
        sources = db.sources(slug)
        if not sources:
            print(f"no enabled source matching {slug!r}", file=sys.stderr)
            return 1

        for source in sources:
            if undelete:
                restored = db.undelete_all(source["id"])
                print(f"{source['slug']}: restored {restored} soft-deleted document(s)")

            pending = db.documents_without_chunks(source["id"])
            print(f"{source['slug']}: {len(pending)} document(s) need chunks")

            for i, doc in enumerate(pending, 1):
                chunks = chunk_markdown(
                    doc["markdown"],
                    target_tokens=cfg.chunk_target_tokens,
                    max_tokens=cfg.chunk_max_tokens,
                    section_whole_max=cfg.section_whole_max_tokens,
                    overlap_ratio=cfg.chunk_overlap_ratio,
                )
                if not chunks:
                    logging.warning("no chunks from stored markdown: %s", doc["url"])
                    continue
                embeddings = llm.embed_documents([c.text for c in chunks])
                db.replace_chunks(doc["id"], chunks, embeddings)
                logging.info("[%d/%d] %s -> %d chunks", i, len(pending), doc["url"], len(chunks))
    return 0


def _status(cfg: Config) -> int:
    with Database(cfg.database_url) as db:
        with db._conn.cursor() as cur:  # noqa: SLF001 - admin CLI, fine
            cur.execute(
                """SELECT s.slug, r.id, r.status, r.started_at, r.finished_at,
                          r.pages_seen, r.pages_changed, r.pages_deleted, r.error
                     FROM crawl_runs r JOIN sources s ON s.id = r.source_id
                 ORDER BY r.started_at DESC LIMIT 15"""
            )
            rows = cur.fetchall()

    if not rows:
        print("no crawl runs yet")
        return 0
    print(f"{'source':<14}{'run':>5} {'status':<9}{'seen':>6}{'changed':>9}"
          f"{'deleted':>9}  started")
    for r in rows:
        print(f"{r['slug']:<14}{r['id']:>5} {r['status']:<9}{r['pages_seen']:>6}"
              f"{r['pages_changed']:>9}{r['pages_deleted']:>9}  "
              f"{r['started_at']:%Y-%m-%d %H:%M}")
        if r["error"]:
            print(f"    ! {r['error']}")
    return 0


def _check(cfg: Config) -> int:
    """Fail loudly and specifically -- this is the first thing to run when
    something is misconfigured, and endpoint paths are easy to get wrong."""
    ok = True
    with LLMClient(cfg) as llm:
        try:
            vectors = llm.embed_documents(["connectivity check"])
            dims = len(vectors[0])
            print(f"embeddings  OK  model={cfg.embedding_model} dims={dims}")
            if dims != 4096:
                print(f"  ! expected 4096 dims, schema declares vector(4096)")
                ok = False
        except Exception as exc:  # noqa: BLE001
            print(f"embeddings  FAIL  {exc}")
            ok = False

        try:
            reply = llm.complete(
                [{"role": "user", "content": "Reply with exactly: OK"}], max_tokens=512
            )
            print(f"chat        OK  model={cfg.crawl_model} reply={reply.strip()!r}")
        except Exception as exc:  # noqa: BLE001
            print(f"chat        FAIL  {exc}")
            print("  ! base URL must end in /api/v1 -- /api/chat/completions returns 403")
            ok = False

    try:
        with Database(cfg.database_url) as db:
            print(f"database    OK  {len(db.sources())} enabled source(s)")
    except Exception as exc:  # noqa: BLE001
        print(f"database    FAIL  {exc}")
        ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())