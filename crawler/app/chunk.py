"""Structure-aware chunking (plan.md §5).

Splits on heading boundaries, never mid-table or mid-code-block, and carries the
heading path on every chunk. That path is prepended at embed time so the vector
knows where in the document it came from -- one of the strongest retrieval signals
available, and precisely what the old flat export destroyed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_FENCE = re.compile(r"^```")


@dataclass
class Chunk:
    ordinal: int
    text: str
    heading_path: list[str] = field(default_factory=list)
    anchor: str | None = None
    token_count: int = 0


@dataclass
class _Block:
    kind: str  # heading | code | table | text
    text: str
    level: int = 0


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars/token, floor of one token per word.

    Deliberately approximate. It only gates chunk sizing, and the true count is
    reconciled by the embedding API's usage figures.
    """
    return max(len(text) // 4, len(text.split()))


def chunk_markdown(
    markdown: str,
    *,
    target_tokens: int = 512,
    max_tokens: int = 1024,
    section_whole_max: int = 1200,
    overlap_ratio: float = 0.15,
) -> list[Chunk]:
    sections = _sections(_blocks(markdown))

    chunks: list[Chunk] = []
    for path, blocks in sections:
        body = "\n\n".join(b.text for b in blocks).strip()
        if not body:
            continue

        if estimate_tokens(body) <= section_whole_max:
            chunks.append(Chunk(len(chunks), body, list(path), _anchor(path)))
            continue

        for piece in _split_section(blocks, target_tokens, max_tokens, overlap_ratio):
            chunks.append(Chunk(len(chunks), piece, list(path), _anchor(path)))

    for c in chunks:
        c.token_count = estimate_tokens(c.text)
    return chunks


def _blocks(markdown: str) -> list[_Block]:
    """Parse Markdown into atomic blocks. Fenced code and tables stay whole."""
    blocks: list[_Block] = []
    lines = markdown.splitlines()
    i = 0

    while i < len(lines):
        line = lines[i]

        if _FENCE.match(line):
            buf = [line]
            i += 1
            while i < len(lines) and not _FENCE.match(lines[i]):
                buf.append(lines[i])
                i += 1
            if i < len(lines):
                buf.append(lines[i])
                i += 1
            blocks.append(_Block("code", "\n".join(buf)))
            continue

        if (m := _HEADING.match(line)) is not None:
            blocks.append(_Block("heading", line, level=len(m.group(1))))
            i += 1
            continue

        if line.lstrip().startswith("|"):
            buf = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                buf.append(lines[i])
                i += 1
            blocks.append(_Block("table", "\n".join(buf)))
            continue

        buf = []
        while i < len(lines) and lines[i].strip() and not _HEADING.match(lines[i]) \
                and not _FENCE.match(lines[i]) and not lines[i].lstrip().startswith("|"):
            buf.append(lines[i])
            i += 1
        if buf:
            blocks.append(_Block("text", "\n".join(buf)))
        else:
            i += 1

    return blocks


def _sections(blocks: list[_Block]) -> list[tuple[list[str], list[_Block]]]:
    """Group blocks under their heading path."""
    sections: list[tuple[list[str], list[_Block]]] = []
    path: list[str] = []
    current: list[_Block] = []

    for block in blocks:
        if block.kind == "heading":
            if current:
                sections.append((list(path), current))
                current = []
            title = _HEADING.match(block.text).group(2).strip()  # type: ignore[union-attr]
            del path[block.level - 1 :]
            path.append(title)
        else:
            current.append(block)

    if current:
        sections.append((list(path), current))
    return sections


def _split_section(
    blocks: list[_Block], target: int, hard_max: int, overlap_ratio: float
) -> list[str]:
    """Pack blocks up to `target`, never splitting a code block or table."""
    out: list[str] = []
    buf: list[_Block] = []
    size = 0

    def flush() -> None:
        nonlocal buf, size
        if buf:
            out.append("\n\n".join(b.text for b in buf).strip())
            # Carry the tail of the previous chunk forward so a sentence spanning
            # a boundary is still retrievable from either side.
            tail, kept = [], 0
            budget = int(target * overlap_ratio)
            for b in reversed(buf):
                if b.kind in ("code", "table") or kept >= budget:
                    break
                tail.insert(0, b)
                kept += estimate_tokens(b.text)
            buf, size = tail, kept

    for block in blocks:
        tokens = estimate_tokens(block.text)

        # An oversized atomic block becomes its own chunk rather than being cut.
        if block.kind in ("code", "table") and tokens > hard_max:
            flush()
            if buf:
                out.append("\n\n".join(b.text for b in buf).strip())
                buf, size = [], 0
            out.append(block.text)
            continue

        if size + tokens > target and buf:
            flush()

        buf.append(block)
        size += tokens

    if buf:
        out.append("\n\n".join(b.text for b in buf).strip())

    return [chunk for chunk in out if chunk.strip()]


def _anchor(path: list[str]) -> str | None:
    """GitHub-style slug of the deepest heading, for deep links into a page."""
    if not path:
        return None
    slug = re.sub(r"[^\w\s-]", "", path[-1].lower())
    return "#" + re.sub(r"[\s_]+", "-", slug).strip("-")
