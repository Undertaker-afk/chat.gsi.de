"""Egress scope: the single place that decides whether a URL may be fetched.

Every outbound request the crawler makes goes through `in_scope()` -- connector
discovery, page fetches, sitemap indexes, and the images the vision pass pulls.

It lives in its own module rather than as a connector method because the leak
that motivated it had no connector involved. A wiki topic embedded an image
hosted on SourceForge; `vision.apply_vision` fetched it with follow_redirects on
and no host check, and the crawl walked a mirror redirect chain
(sourceforge.net -> downloads.sourceforge.net -> master.dl.sourceforge.net),
89 requests to each, while both connectors were correctly staying on wiki.gsi.de.
A per-connector check cannot catch that; a shared choke point can.
"""

from __future__ import annotations

from urllib.parse import urlparse

#: Default egress boundary. Subdomains included, so `gsi.de` admits
#: `www.gsi.de` and `virgo-docs.hpc.gsi.de` but not `gsi.de.example.com`.
DEFAULT_ALLOWED_HOSTS: tuple[str, ...] = ("gsi.de",)

#: Only these schemes are ever fetched. Excludes javascript:, data:, file:,
#: ftp: and friends, which either cannot be crawled or should not be.
_ALLOWED_SCHEMES = frozenset({"http", "https"})


def normalise_hosts(hosts: object | None) -> tuple[str, ...]:
    """Coerce a configured host list into the form `in_scope` expects."""
    if not hosts:
        return DEFAULT_ALLOWED_HOSTS
    if isinstance(hosts, str):
        hosts = [hosts]
    return tuple(h.strip().lower().strip(".") for h in hosts if h and h.strip())


def host_of(url: str) -> str:
    """Bare lowercase hostname, with any userinfo and port stripped.

    `https://user:pw@evil.com:8443/x` -> `evil.com`. Splitting on "@" from the
    right matters: `https://gsi.de@evil.com/` is an evil.com URL, and taking the
    left-hand side would read it as gsi.de.
    """
    netloc = urlparse(url).netloc
    return netloc.rsplit("@", 1)[-1].split(":")[0].lower().rstrip(".")


def in_scope(url: str, allow_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS) -> bool:
    """True if `url` may be fetched: allowed scheme AND host at-or-under a suffix."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        return False
    host = host_of(url)
    if not host:
        return False
    return any(host == allowed or host.endswith("." + allowed) for allowed in allow_hosts)
