"""Foswiki connector for wiki.gsi.de.

Engine confirmed 2026-07-27: Foswiki (the "FOSS Wiki" in the design sketch).
Probing established the following, and the design follows from it:

* **No sitemap.xml, no usable index.** `WebIndex`, `WebTopicList` and `WebRss` are
  all login-gated for guests even where the content topics are public, so
  discovery has to be a link crawl seeded from each web's `WebHome`.
* **`?skin=text` returns the topic body without navigation chrome** -- roughly
  2 KB instead of 8.5 KB for the same topic. Extraction quality is far better
  from this than from the full page, so every fetch uses it.
* **Anonymous access is the access-control boundary.** The site itself says
  "Some webs are restricted and hidden from the list of webs on the left. Please
  log in to view them." Crawling anonymously therefore sees exactly the public
  corpus, and a restricted web returns a login page rather than content. This is
  why the crawler must NEVER be given wiki credentials: anonymity is the ACL
  enforcement mechanism (plan.md §12).
* **robots.txt sets `Crawl-delay: 5`.** Deliberately not applied to
  wiki.gsi.de: it is GSI's own wiki and this is GSI's own crawler, so the delay
  aimed at third-party crawlers is waived (see `_min_interval` below). Any other
  host this connector is ever pointed at keeps the 5s floor. Note this connector
  never fetches or parses robots.txt at all -- the Disallow list is baked into
  ACTION_PATHS below, and those paths stay excluded regardless, because they are
  edit/save/login endpoints that are pointless and destructive to crawl rather
  than merely impolite.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Iterable
from urllib.parse import urljoin, urlparse, urldefrag

import httpx
from selectolax.parser import HTMLParser

from ..scope import normalise_hosts
from .base import Connector, NotModified, PageRef, RawPage, _conditional_headers

log = logging.getLogger(__name__)

#: Foswiki's per-web machinery. Real content never lives here, and several of
#: these are login-gated anyway.
SYSTEM_TOPICS = frozenset(
    {
        "WebAtom", "WebChanges", "WebCreateNewTopic", "WebHome", "WebIndex",
        "WebLeftBar", "WebNotify", "WebPreferences", "WebRss", "WebSearch",
        "WebSearchAdvanced", "WebStatistics", "WebTopicCreator", "WebTopicList",
        "WebTopMenu",
    }
)

#: Webs holding Foswiki's own manual rather than GSI content. Indexing these
#: would answer "how do I use Foswiki" instead of "how do I use Virgo".
SYSTEM_WEBS = frozenset({"System", "Sandbox", "Trash", "TWiki"})

#: Script paths from robots.txt Disallow, plus the rest. Never fetched.
ACTION_PATHS = frozenset(
    {
        "attach", "changes", "configure", "edit", "geturl", "installpasswd",
        "login", "logon", "logos", "mailnotify", "manage", "oops", "passwd",
        "preview", "rdiff", "rdiffauth", "register", "rename", "resetpasswd",
        "rest", "save", "savemulti", "search", "statistics", "upload", "view",
        "viewauth", "viewfile",
    }
)

_TOPIC_PATH = re.compile(r"^/([A-Z][A-Za-z0-9]*(?:/[A-Z][A-Za-z0-9]*)*)/([A-Z][A-Za-z0-9_]*)$")
_TITLE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
#: Foswiki preference settings leak into skin=text output as
#: `<!-- * Set ALLOWTOPICCHANGE = HpcGroup -->`. Noise, and occasionally
#: discloses group names -- stripped before extraction.
_SET_DIRECTIVE = re.compile(r"^\s*(?:\*\s*)?Set\s+[A-Z][A-Z0-9_]*\s*=.*$", re.M)


class FoswikiConnector(Connector):
    def __init__(
        self,
        slug: str,
        base_url: str,
        config: dict,
        *,
        user_agent: str,
        rate_limit_rps: float = 0.2,
        max_pages: int = 20_000,
    ) -> None:
        self.slug = slug
        self.base_url = base_url.rstrip("/") + "/"
        self.config = config
        self.max_pages = int(config.get("max_pages", max_pages))
        self._webs: list[str] | None = config.get("webs")
        # Foswiki's own manual plus whatever the source config excludes. Read by
        # _discover_webs and _is_indexable, so it must exist before either runs.
        self._exclude_webs = SYSTEM_WEBS | set(config.get("exclude_webs") or [])
        # Not used by this connector's own link filtering, which is stricter
        # (exact host match on base_url). It is here because the vision pass
        # fetches images referenced by these pages and needs a boundary to apply.
        self.allow_hosts = normalise_hosts(config.get("allow_hosts"))

        # Normalize host for policy checks
        parsed = urlparse(base_url)
        self._host = parsed.netloc

        # wiki.gsi.de is GSI's own wiki, crawled by GSI for GSI's own assistant,
        # so the Crawl-delay aimed at outside crawlers does not apply. This must
        # override *both* inputs below: CRAWL_RATE_LIMIT_RPS=0.2 alone yields a
        # 5s interval, and the source config sets crawl_delay_s=5 on top of it,
        # so anything short of a hard 0 leaves the delay in place.
        is_gsi_wiki = self._host == "wiki.gsi.de"
        if is_gsi_wiki:
            self._min_interval = 0.0
        else:
            requested = 1.0 / rate_limit_rps if rate_limit_rps > 0 else 5.0
            self._min_interval = max(requested, float(config.get("crawl_delay_s", 5.0)))
        # Slot reservation, not "time since last request" -- see the same comment
        # in HtmlSitemapConnector. Discovery runs on one thread here, but fetch()
        # is called from the worker pool, so the two share this pacer.
        self._slot_lock = threading.Lock()
        self._next_slot = 0.0

        # One client for the whole crawl: connection reuse matters over hundreds
        # of topics. `Accept-Encoding: identity` because the proxy in front of the
        # LLM has been seen to mislabel compressed bodies, and the same defensive
        # setting costs nothing here.
        self._http = httpx.Client(
            headers={"User-Agent": user_agent, "Accept-Encoding": "identity"},
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

        # Discovery already fetches every page to read its links; without this the
        # pipeline would fetch each one a second time, doubling both crawl duration
        # and load on the wiki. Bounded so a large web cannot exhaust memory.
        self._cache: dict[str, str] = {}
        self._cache_limit = 512

    # --- Connector ------------------------------------------------------------

    def supports_incremental(self) -> bool:
        # WebChanges/WebRss are login-gated for guests, so there is no change feed
        # we can read. The pipeline's content-hash check does the incremental work.
        return False

    def changed_since(self, since: datetime) -> Iterable[PageRef]:
        raise NotImplementedError("Foswiki change feeds are login-gated for anonymous users")

    def discover(self) -> Iterable[PageRef]:
        webs = self._webs or self._discover_webs()
        log.info("[%s] crawling %d web(s): %s", self.slug, len(webs), ", ".join(sorted(webs)))

        seen: set[str] = set()
        for web in webs:
            for ref in self._crawl_web(web, seen):
                yield ref
                if len(seen) >= self.max_pages:
                    log.warning("[%s] hit max_pages=%d", self.slug, self.max_pages)
                    return

    def fetch(self, ref: PageRef, known_revision: str | None = None) -> RawPage:
        """Fetch a topic, conditionally when we have a validator for it.

        Foswiki's change feeds (WebChanges, WebRss) are login-gated for guests,
        so discovery cannot tell us what changed -- that is why
        supports_incremental() is False. A conditional GET is the next best
        thing: the request still happens and still pays the 5 s crawl delay, but
        a 304 skips LLM extraction, chunking and embedding, which is ~27 s of the
        ~28 s a page really costs. That is where the saving actually is.
        """
        # skin=text drops the sidebar, header, footer and edit controls.
        html = self._cache.pop(ref.url, None)
        revision = None

        if html is None:
            url = ref.url + ("&" if "?" in ref.url else "?") + "skin=text"
            resp = self._get_response(url, _conditional_headers(known_revision))
            if resp is None:
                raise RuntimeError(f"fetch failed: {ref.url}")
            if resp.status_code == 304:
                raise NotModified(ref.url)
            html = resp.text
            revision = resp.headers.get("etag") or resp.headers.get("last-modified")

        title = _clean_title(html) or _title_from_url(ref.url)
        if _is_login_page(html, title):
            # A restricted topic. Expected and harmless -- skip it, never retry
            # with credentials.
            raise PermissionError(f"restricted topic (login required): {ref.url}")

        return RawPage(
            url=ref.url,
            title=title,
            html=_SET_DIRECTIVE.sub("", html),
            lang="en",
            revision=revision,
            fetched_at=datetime.now(timezone.utc),
        )

    # --- discovery ------------------------------------------------------------

    def _discover_webs(self) -> list[str]:
        """Read the web list from Main/WebHome's navigation.

        Anonymously this yields only public webs -- restricted ones are hidden
        from that list by design, which is precisely the boundary we want.
        """
        html = self._get(urljoin(self.base_url, "Main/WebHome"))
        if not html:
            log.warning("[%s] could not read web list, falling back to Main", self.slug)
            return ["Main"]

        webs = {
            match
            for match in re.findall(r'href="/([A-Z][A-Za-z0-9]*)/WebHome"', html)
            if match not in self._exclude_webs
        }
        return sorted(webs) or ["Main"]

    def _crawl_web(self, web: str, seen: set[str]) -> Iterable[PageRef]:
        """Breadth-first link crawl within one web, seeded from WebTopicList.

        WebHome alone is not a map of a web, only of what someone chose to link
        from its front page. Measured on wiki.gsi.de: crawling from WebHome
        across all 27 webs reached 157 topics, while the webs' own WebTopicList
        pages list 1592 (CSframework 337, Epics 283, Linux 172). Everything else
        is an orphan as far as the front page is concerned -- reachable, indexed
        by Foswiki, and invisible to us.

        The original comment here assumed WebIndex and WebTopicList were
        login-gated for anonymous users. WebIndex and WebChanges are; verified
        2026-08-03, WebTopicList is NOT, and it lists every topic in the web.

        Still a link crawl underneath: WebTopicList seeds the queue, and links
        found while crawling are followed as before, so a topic missing from
        both is still reached if anything links to it.
        """
        start = urljoin(self.base_url, f"{web}/WebHome")
        queue: list[str] = [start]
        queued = {start}

        for url in self._topics_from_list(web):
            if url not in queued and self._is_indexable(url, web):
                queued.add(url)
                queue.append(url)

        while queue and len(seen) < self.max_pages:
            url = queue.pop(0)
            if url in seen:
                continue

            html = self._get(url + "?skin=text")
            if not html:
                # Unreachable, off-site redirect, or non-HTML. Do not yield it --
                # the pipeline would only fetch it again and fail.
                seen.add(url)
                continue

            seen.add(url)
            if len(self._cache) < self._cache_limit:
                self._cache[url] = html
            yield PageRef(url=url)

            for node in HTMLParser(html).css("a[href]"):
                href = node.attributes.get("href")
                if not href:
                    continue
                candidate = urldefrag(urljoin(url, href)).url
                if candidate in queued or not self._is_indexable(candidate, web):
                    continue
                queued.add(candidate)
                queue.append(candidate)

    def _topics_from_list(self, web: str) -> list[str]:
        """Every topic WebTopicList names for this web, as absolute URLs.

        Best-effort: a web whose list is restricted or missing simply falls back
        to the WebHome link crawl, which is what every web did before.
        """
        html = self._get(urljoin(self.base_url, f"{web}/WebTopicList") + "?skin=text")
        if not html:
            log.debug("[%s] no WebTopicList for %s", self.slug, web)
            return []

        urls = []
        for node in HTMLParser(html).css("a[href]"):
            href = node.attributes.get("href")
            if not href:
                continue
            urls.append(urldefrag(urljoin(self.base_url, href)).url)

        unique = list(dict.fromkeys(urls))
        log.info("[%s] %s: %d topic(s) listed in WebTopicList", self.slug, web, len(unique))
        return unique

    def _is_indexable(self, url: str, web: str) -> bool:
        parsed = urlparse(url)
        if parsed.netloc != urlparse(self.base_url).netloc:
            return False
        # Query strings mean an action (?raw=, ?rev=, ?cover=), not a topic.
        if parsed.query:
            return False

        match = _TOPIC_PATH.match(parsed.path)
        if not match:
            return False

        path_web, topic = match.group(1), match.group(2)
        root = path_web.split("/")[0]

        if root in ACTION_PATHS or root in self._exclude_webs:
            return False
        if topic in SYSTEM_TOPICS:
            return False
        # Stay inside the web being crawled; other webs get their own pass, which
        # keeps the frontier bounded and the logs readable.
        return root == web

    # --- http -----------------------------------------------------------------

    def _get(self, url: str) -> str | None:
        resp = self._get_response(url)
        return None if resp is None else resp.text

    def _get_response(self, url: str, headers: dict[str, str] | None = None):
        """The raw response, so callers can read ETag / Last-Modified.

        A 304 is returned rather than filtered out here: only fetch() knows that
        it asked a conditional question, and only it can turn the answer into
        NotModified.
        """
        self._throttle()
        try:
            resp = self._follow_on_site(url, headers or {})
        except Exception as exc:  # noqa: BLE001
            log.debug("[%s] %s failed: %s", self.slug, url, exc)
            return None
        if resp is None:
            return None

        if resp.status_code == 304:
            return resp

        if resp.status_code != 200:
            log.debug("[%s] %s -> %d", self.slug, url, resp.status_code)
            return None

        return resp

    #: Enough for the in-site redirect chains Foswiki produces, few enough that a
    #: redirect loop ends quickly.
    MAX_REDIRECTS = 5

    def _follow_on_site(self, url: str, headers: dict[str, str]):
        """GET, following redirects only while they stay on the wiki's host.

        The host check has to happen BEFORE the body is read, not after. Several
        Foswiki topics are redirect stubs to downloads:

            wiki.gsi.de/CSframework/CSPackagingLV2009Current?skin=text  302
              -> sourceforge.net/.../CSPackaging_1.05.zip/download      302
              -> master.dl.sourceforge.net/.../CSPackaging_1.05.zip

        With redirects followed automatically, httpx downloaded that archive in
        full and only then was it discarded for not being HTML -- tens of
        megabytes and, measured in the crawl log, 13 seconds per such topic, for
        a page that is never indexed either way. Attachments are fetched
        deliberately by the media path, never as a side effect of a topic
        redirect.

        Non-HTML responses are dropped without reading the body for the same
        reason: a wiki attachment can be arbitrarily large and this connector
        indexes topics, not files.
        """
        host = urlparse(self.base_url).netloc
        current = url

        for _ in range(self.MAX_REDIRECTS):
            with self._http.stream("GET", current, headers=headers,
                                   follow_redirects=False) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location")
                    if not location:
                        return None
                    target = urljoin(current, location)
                    if urlparse(target).netloc != host:
                        log.debug("[%s] %s redirects off-site to %s -- not following",
                                  self.slug, current, target)
                        return None
                    current = target
                    continue

                if resp.status_code == 304:
                    resp.read()
                    return resp
                if resp.status_code != 200:
                    log.debug("[%s] %s -> %d", self.slug, current, resp.status_code)
                    return None
                if "html" not in resp.headers.get("content-type", ""):
                    log.debug("[%s] %s is %s -- not downloading", self.slug, current,
                              resp.headers.get("content-type", "unknown"))
                    return None

                resp.read()
                return resp

        log.debug("[%s] %s exceeded %d redirects", self.slug, url, self.MAX_REDIRECTS)
        return None

    def _throttle(self) -> None:
        if self._min_interval <= 0:
            return
        with self._slot_lock:
            now = time.monotonic()
            slot = max(now, self._next_slot)
            self._next_slot = slot + self._min_interval
        wait = slot - time.monotonic()
        if wait > 0:
            time.sleep(wait)


def _clean_title(html: str) -> str:
    """Foswiki titles read 'Topic < Web < GSI Wiki'. Keep the topic.

    Returns "" when the fragment has no <title> at all, which is the normal case
    for ?skin=text -- the caller then falls back to the URL.
    """
    match = _TITLE.search(html)
    if not match:
        return ""
    raw = re.sub(r"\s+", " ", match.group(1)).strip()
    raw = raw.replace("&lt;", "<").replace("&amp;", "&").replace("&gt;", ">")
    return raw.split("<")[0].strip() or raw


def _title_from_url(url: str) -> str:
    """Derive a readable title from the topic name: LustreFs -> 'Lustre Fs'.

    Foswiki topic names are WikiWords, so this is always a usable fallback and
    beats storing "Untitled" for every page the LLM extractor did not title.
    """
    topic = urlparse(url).path.rstrip("/").rsplit("/", 1)[-1] or "Untitled"
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", topic.replace("_", " "))
    return spaced.strip() or topic


def _is_login_page(html: str, title: str) -> bool:
    return "login" in title.lower() or "GSI Wiki login" in html[:2000]
