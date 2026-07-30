"""HTML -> Markdown extraction.

Deterministic extraction runs first. The vision model is invoked only where the
heuristics below say the deterministic result is untrustworthy -- see needs_vision().
A blanket vision pass over a full recrawl would cost thousands of calls for almost
no gain (plan.md §5).
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field

from selectolax.parser import HTMLParser, Node

log = logging.getLogger(__name__)

# Stripped before extraction: navigation chrome carries no answers but does carry
# a lot of text, which poisons both chunking and the text-density heuristic.
_CHROME = (
    "script, style, noscript, nav, header, footer, aside, form, "
    "[role=navigation], [role=banner], [role=contentinfo], "
    ".navbar, .sidebar, .toc, #toc, .breadcrumb, .footer, .header, "
    ".mw-editsection, .printfooter, .catlinks, #jump-to-nav"
)

# Tried in order; first hit wins. Falls back to <body>.
_CONTENT_SELECTORS = (
    "main", "article", "#content", "#mw-content-text", ".mw-parser-output",
    "#bodyContent", ".page-content", ".content", "[role=main]",
)


@dataclass
class ExtractedPage:
    markdown: str
    title: str
    headings: list[str] = field(default_factory=list)
    images: list["ImageRef"] = field(default_factory=list)
    text_density: float = 1.0


@dataclass
class ImageRef:
    src: str
    alt: str
    placeholder: str  #: token in the markdown to replace with a vision caption


def extract(html: str, url: str, title: str) -> ExtractedPage:
    tree = HTMLParser(html)
    for node in tree.css(_CHROME):
        node.decompose()

    root = next((n for sel in _CONTENT_SELECTORS if (n := tree.css_first(sel))), None)
    if root is None:
        root = tree.css_first("body") or tree.root
    if root is None:
        return ExtractedPage(markdown="", title=title)

    images: list[ImageRef] = []
    headings: list[str] = []
    parts = _render(root, images, headings, url)

    markdown = re.sub(r"\n{3,}", "\n\n", "\n\n".join(p for p in parts if p.strip())).strip()
    return ExtractedPage(
        markdown=markdown,
        title=title,
        headings=headings,
        images=images,
        text_density=_text_density(html, markdown),
    )


def needs_vision(page: ExtractedPage) -> bool:
    """Whether to spend a vision call on this page.

    Two triggers, both cheap to evaluate:
      1. Very low text density -- the deterministic extractor produced almost
         nothing relative to the markup, so the page is probably layout- or
         image-driven and the Markdown is mush.
      2. Images with no meaningful alt text -- a figure that carries information
         nothing else on the page recovers.
    """
    if page.text_density < 0.05 and len(page.markdown) < 400:
        return True
    return any(len(img.alt.strip()) < 8 for img in page.images)


# --- rendering ---------------------------------------------------------------


def _render(node: Node, images: list[ImageRef], headings: list[str], base: str) -> list[str]:
    out: list[str] = []
    # Bare text nodes must be included. Foswiki's skin=text emits body copy as
    # loose text between empty <p></p> separators; iterating with
    # include_text=False silently dropped almost every page's content.
    pending: list[str] = []

    def flush_text() -> None:
        if pending:
            text = re.sub(r"\s+", " ", " ".join(pending)).strip()
            if text:
                out.append(text)
            pending.clear()

    for child in node.iter(include_text=True):
        tag = child.tag

        if tag == "-text":
            pending.append(child.text(deep=False))
            continue

        flush_text()

        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            text = _inline(child)
            if text:
                level = int(tag[1])
                headings.append(text)
                out.append(f"{'#' * level} {text}")

        elif tag == "p":
            if text := _inline(child):
                out.append(text)

        elif tag == "pre":
            code = child.text(deep=True)
            if code.strip():
                lang = _code_lang(child)
                out.append(f"```{lang}\n{code.rstrip()}\n```")

        elif tag in ("ul", "ol"):
            if items := _list(child, ordered=(tag == "ol")):
                out.append(items)

        elif tag == "table":
            if table := _table(child):
                out.append(table)

        elif tag == "blockquote":
            if text := _inline(child):
                out.append("\n".join(f"> {line}" for line in text.splitlines()))

        elif tag == "img":
            out.append(_image(child, images, base))

        elif tag == "figure":
            img = child.css_first("img")
            caption = child.css_first("figcaption")
            if img is not None:
                out.append(_image(img, images, base, caption=_inline(caption) if caption else ""))

        elif tag in ("div", "section", "main", "article", "td", "li", "dl"):
            out.extend(_render(child, images, headings, base))

    return out


def _image(node: Node, images: list[ImageRef], base: str, caption: str = "") -> str:
    src = node.attributes.get("src") or ""
    alt = caption or node.attributes.get("alt") or ""
    placeholder = f"<!--VISION:{hashlib.sha1(src.encode()).hexdigest()[:12]}-->"
    images.append(ImageRef(src=_abs(src, base), alt=alt, placeholder=placeholder))
    return f"![{alt}]({_abs(src, base)})\n{placeholder}"


def _inline(node: Node) -> str:
    """Flatten a node to Markdown inline text, keeping code/emphasis/links."""
    parts: list[str] = []
    for child in node.iter(include_text=True):
        if child.tag == "-text":
            parts.append(child.text(deep=False))
        elif child.tag == "code":
            parts.append(f"`{child.text(deep=True).strip()}`")
        elif child.tag in ("strong", "b"):
            parts.append(f"**{_inline(child)}**")
        elif child.tag in ("em", "i"):
            parts.append(f"*{_inline(child)}*")
        elif child.tag == "a":
            text = _inline(child)
            href = child.attributes.get("href") or ""
            parts.append(f"[{text}]({href})" if text and href else text)
        elif child.tag == "br":
            parts.append("\n")
        else:
            parts.append(_inline(child))
    return re.sub(r"[ \t]{2,}", " ", "".join(parts)).strip()


def _list(node: Node, ordered: bool) -> str:
    lines: list[str] = []
    for i, li in enumerate(node.css("li"), start=1):
        if text := _inline(li):
            marker = f"{i}." if ordered else "-"
            lines.append(f"{marker} {text}")
    return "\n".join(lines)


def _table(node: Node) -> str:
    """Render a real Markdown table.

    This is the single biggest win over the old flat export, which collapsed
    tables into unreadable runs like `VAE'25Debian 122027`.
    """
    rows = [[_inline(c) for c in tr.css("th, td")] for tr in node.css("tr")]
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    if not rows:
        return ""

    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    header, body = rows[0], rows[1:]
    lines = [
        "| " + " | ".join(c.replace("|", "\\|") for c in header) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    lines += ["| " + " | ".join(c.replace("|", "\\|") for c in r) + " |" for r in body]
    return "\n".join(lines)


def _code_lang(node: Node) -> str:
    code = node.css_first("code") or node
    for attr in (code.attributes.get("class"), node.attributes.get("class")):
        if not attr:
            continue
        for cls in attr.split():
            if cls.startswith(("language-", "lang-")):
                return cls.split("-", 1)[1]
            if cls in ("bash", "sh", "shell", "python", "c", "cpp", "yaml", "json", "sql"):
                return cls
    return ""


def _abs(src: str, base: str) -> str:
    from urllib.parse import urljoin

    return urljoin(base, src) if src and not src.startswith(("http", "data:")) else src


def _text_density(html: str, markdown: str) -> float:
    return len(markdown) / len(html) if html else 0.0
