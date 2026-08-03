"""Sitemap-driven HTML connector -- the fallback that works against any site.

Default for wiki.gsi.de until the engine is confirmed. Falls back to a bounded
same-origin link crawl when no sitemap is published.
"""

from __future__ import annotations

import fnmatch
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import urljoin, urlparse, urldefrag
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

import httpx
from selectolax.parser import HTMLParser

from ..scope import in_scope, normalise_hosts
from .base import Connector, NotModified, PageRef, RawPage, _conditional_headers

log = logging.getLogger(__name__)

_SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


class HtmlSitemapConnector(Connector):
    def __init__(
        self,
        slug: str,
        base_url: str,
        config: dict,
        *,
        user_agent: str,
        rate_limit_rps: float = 1.0,
        max_pages: int = 10_000,
    ) -> None:
        self.slug = slug
        self.base_url = base_url.rstrip("/") + "/"
        self.config = config
        self.max_pages = max_pages
        
        # Normalize host for policy checks
        parsed = urlparse(base_url)
        self._host = parsed.netloc
        
        # For wiki.gsi.de, enforce no crawl delay and skip robots.txt
        is_gsi_wiki = self._host == "wiki.gsi.de"
        
        self._include = config.get("include") or ["/**"]
        self._exclude = config.get("exclude") or []
        self.allow_hosts = normalise_hosts(config.get("allow_hosts"))
        
        # Calculate rate limiting, but force 0 delay for GSI wiki
        self._min_interval = (1.0 / rate_limit_rps if rate_limit_rps > 0 else 0.0) if is_gsi_wiki else (1.0 / rate_limit_rps if rate_limit_rps > 0 else 5.0)
        # Slot reservation rather than "sleep since last request": fetch() runs on
        # the worker pool, and N threads each measuring against a shared
        # _last_request would fire N requests at once and multiply the rate limit
        # by N. Reserving the next slot under the lock keeps the *aggregate* rate
        # correct however many workers there are.
        self._slot_lock = threading.Lock()
        self._next_slot = 0.0

        self._http = httpx.Client(
            headers={"User-Agent": user_agent},
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )
        
        # Load robots.txt only if not GSI wiki
        self._robots = None if is_gsi_wiki else self._load_robots(user_agent)

    # --- Connector ------------------------------------------------------------

    def supports_incremental(self) -> bool:
        # A sitemap's <lastmod> is advisory and frequently wrong or absent, so we
        # do not trust it as a change oracle. The content-hash check in the
        # pipeline is the real incremental mechanism for this connector.
        return False

    def changed_since(self, since: datetime) -> Iterable[PageRef]:
        raise NotImplementedError("html connector has no reliable change feed")

    def discover(self) -> Iterable[PageRef]:
        refs = list(self._from_sitemap())
        if refs:
            log.info("%s: %d urls from sitemap", self.slug, len(refs))
        else:
            log.warning("%s: no sitemap, falling back to link crawl", self.slug)
            refs = list(self._from_link_crawl())
        seen: set[str] = set()
        rejected: list[str] = []
        for ref in refs:
            if ref.url in seen:
                continue
            if not self._allowed(ref.url):
                rejected.append(ref.url)
                continue
            seen.add(ref.url)
            yield ref

        # "52 urls from sitemap" followed by "discovery returned no pages" is a
        # true and useless pair of lines: it took a sitemap fetch and a read of
        # this file to learn that `include: ["/user-guide/**"]` matched none of
        # the site's actual `/virgo/user-guide/...` paths. If the patterns threw
        # everything away, say so, and show what was thrown away.
        if rejected and not seen:
            log.error(
                "%s: all %d discovered url(s) were rejected by the source's "
                "include/exclude patterns (include=%s exclude=%s). Example paths: %s",
                self.slug, len(rejected), self._include or ["(everything)"],
                self._exclude or ["(nothing)"],
                ", ".join(urlparse(u).path or "/" for u in rejected[:3]))
        elif rejected:
            log.info("%s: %d url(s) skipped by include/exclude patterns",
                     self.slug, len(rejected))

    def fetch(self, ref: PageRef, known_revision: str | None = None) -> RawPage:
        if not self._in_scope(ref.url):
            raise RuntimeError(f"refusing out-of-scope fetch: {ref.url}")

        self._throttle()
        resp = self._http.get(ref.url, headers=_conditional_headers(known_revision))
        # 304 first: raise_for_status() is happy with it, and the body is empty,
        # so anything downstream would read it as a page that lost its content.
        if resp.status_code == 304:
            raise NotModified(ref.url)
        resp.raise_for_status()

        # follow_redirects is on, so an in-domain URL can land off-domain and the
        # document would then be stored under the external URL (str(resp.url)
        # below). Checked here for the same reason FoswikiConnector._get does.
        if not self._in_scope(str(resp.url)):
            raise RuntimeError(f"redirected out of scope: {ref.url} -> {resp.url}")

        tree = HTMLParser(resp.text)
        title_node = tree.css_first("h1") or tree.css_first("title")
        title = (title_node.text(strip=True) if title_node else ref.url)

        html_node = tree.css_first("html")
        lang = html_node.attributes.get("lang") if html_node else None

        return RawPage(
            url=str(resp.url),
            title=title,
            html=resp.text,
            lang=(lang.split("-")[0] if lang else None),
            revision=resp.headers.get("etag") or resp.headers.get("last-modified"),
            fetched_at=datetime.now(timezone.utc),
        )

    # --- discovery ------------------------------------------------------------

    def _from_sitemap(self) -> Iterable[PageRef]:
        path = self.config.get("sitemap", "/sitemap.xml")
        yield from self._read_sitemap(urljoin(self.base_url, path.lstrip("/")), depth=0)

    def _read_sitemap(self, url: str, depth: int) -> Iterable[PageRef]:
        if depth > 3:
            return
        try:
            self._throttle()
            resp = self._http.get(url)
            resp.raise_for_status()
            root = ElementTree.fromstring(resp.content)
        except Exception as exc:  # noqa: BLE001 - absent sitemap is normal
            log.debug("%s: sitemap %s unavailable: %s", self.slug, url, exc)
            return

        # Nested sitemap index. Checked here rather than in _allowed because this
        # branch *fetches* the URL -- by the time discover() filters anything the
        # off-site request has already gone out.
        for node in root.findall("sm:sitemap/sm:loc", _SITEMAP_NS):
            if not node.text:
                continue
            nested = node.text.strip()
            if not self._in_scope(nested):
                log.warning("%s: out of scope, skipping nested sitemap %s", self.slug, nested)
                continue
            yield from self._read_sitemap(nested, depth + 1)

        for entry in root.findall("sm:url", _SITEMAP_NS):
            loc = entry.find("sm:loc", _SITEMAP_NS)
            if loc is None or not loc.text:
                continue
            lastmod = entry.find("sm:lastmod", _SITEMAP_NS)
            yield PageRef(
                url=urldefrag(loc.text.strip()).url,
                last_modified=_parse_iso(lastmod.text) if lastmod is not None and lastmod.text else None,
            )

    def _from_link_crawl(self) -> Iterable[PageRef]:
        origin = urlparse(self.base_url).netloc
        queue, seen = [self.base_url], {self.base_url}

        while queue and len(seen) < self.max_pages:
            url = queue.pop(0)
            try:
                self._throttle()
                resp = self._http.get(url)
                resp.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                log.debug("%s: %s unreachable: %s", self.slug, url, exc)
                continue

            if "html" not in resp.headers.get("content-type", ""):
                continue
            yield PageRef(url=str(resp.url))

            for node in HTMLParser(resp.text).css("a[href]"):
                href = node.attributes.get("href")
                if not href or href.startswith(("mailto:", "tel:", "javascript:")):
                    continue
                nxt = urldefrag(urljoin(url, href)).url
                if urlparse(nxt).netloc != origin or nxt in seen:
                    continue
                if not self._allowed(nxt):
                    continue
                seen.add(nxt)
                queue.append(nxt)

    # --- policy ---------------------------------------------------------------

    def _in_scope(self, url: str) -> bool:
        """Host-level scope check -- the guard the glob patterns cannot provide."""
        return in_scope(url, self.allow_hosts)

    def _allowed(self, url: str) -> bool:
        if not self._in_scope(url):
            log.warning("%s: out of scope, skipping %s", self.slug, url)
            return False
        if self._robots and not self._robots.can_fetch("*", url):
            return False
        path = urlparse(url).path or "/"
        if any(_glob(path, pat) for pat in self._exclude):
            return False
        return any(_glob(path, pat) for pat in self._include)

    def _load_robots(self, user_agent: str) -> RobotFileParser | None:
        try:
            resp = self._http.get(urljoin(self.base_url, "/robots.txt"))
            if resp.status_code != 200:
                return None
            parser = RobotFileParser()
            parser.parse(resp.text.splitlines())
            return parser
        except Exception:  # noqa: BLE001
            return None

    def _throttle(self) -> None:
        if self._min_interval <= 0:
            return
        # The sleep is deliberately outside the lock: holding it across the sleep
        # would serialise the workers rather than merely pace their requests.
        with self._slot_lock:
            now = time.monotonic()
            slot = max(now, self._next_slot)
            self._next_slot = slot + self._min_interval
        wait = slot - time.monotonic()
        if wait > 0:
            time.sleep(wait)


def _glob(path: str, pattern: str) -> bool:
    # Treat '**' as "any depth" by also matching the single-star form, so '/**'
    # matches '/' itself and '/a/b' alike.
    if fnmatch.fnmatch(path, pattern):
        return True
    return fnmatch.fnmatch(path, pattern.replace("**", "*"))


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
