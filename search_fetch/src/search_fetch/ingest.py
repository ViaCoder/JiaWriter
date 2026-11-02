"""search_fetch.ingest — local materials folder → corpus text.

`sf ingest <dir>` walks a working-folder materials directory (参考资料/) and turns
every supported document into corpus-formatted text with a `##### 来源：<dir>/<rel>`
marker per file — the exact shape kb.py's split_pages consumes — so a caller can
prepend interview transcripts, reference PDFs etc. to the research corpus and the
knowledge base retrieves them like any fetched page.

Parsing reuses docparse (pdf/docx/pptx/xlsx/csv/tsv); plain-text notes (.txt/.md)
are decoded directly (utf-8 first, then GBK — the two encodings Chinese material
files actually arrive in). There is no OCR: pictures are unsupported, and a scanned
PDF without a text layer is listed as empty.
"""

# Machine output.
import json

# Directory scanning.
import os

# stdout/stderr.
import sys

# Path arithmetic.
from pathlib import Path

# Saved records and parsing.
from . import artifacts, docparse

# Shared stderr logger.
from .config import _log

# Extensions decoded as plain text.
TEXT_EXTS = {".txt", ".md", ".markdown"}


def _local_kind(path: Path, data: bytes) -> str:
    """Classify a local file: extension first, %PDF magic as the fallback
    (mirrors docparse's CLI file path). '' ⇒ unsupported."""
    # Lower-case extension.
    e = path.suffix.lower()
    # Notes.
    if e in TEXT_EXTS:
        return "text"
    # Office and PDF formats by extension.
    kind = docparse._EXT_KIND.get(e, "")
    # A PDF without the extension.
    if not kind and data[:5] == b"%PDF-":
        kind = "pdf"
    # The kind ('' when unsupported).
    return kind


def _inside(real: Path, real_root: Path) -> bool:
    """True when real is real_root or lies below it."""
    # Both paths are already resolved.
    return real == real_root or real_root in real.parents


def _walk_materials(root: Path):
    """Every visible file under `root` as (rel, real_path_or_None), sorted by rel.
    Symlinks are followed ONLY when their target's real path stays inside the root's
    real path; an escaping (or dangling) link yields real_path None and is never read
    — a link in 参考资料/ to ~/.ssh/… or /etc must not reach the corpus (which is sent
    to remote LLM providers). Symlinked directories inside the root are walked once
    (loop-safe); hidden entries (dot-names) are skipped."""
    # Real path of the root.
    real_root = root.resolve()
    # Results, visited real directories, real dirs to walk, symlinked dirs to walk.
    out, seen, stack, linked = [], set(), [(root, Path("."))], []
    # Walk until both queues are empty.
    while stack or linked:
        # Real directories first, symlinked ones after: a folder reachable both ways is
        # reported under its real name, the alias only adds what is not seen yet.
        d, rel_d = stack.pop() if stack else linked.pop(0)
        # A directory that vanished or cannot be listed is skipped.
        try:
            # Real path of this directory.
            real_d = d.resolve()
            # Each real directory once (symlink loops end here).
            if real_d in seen:
                continue
            # Mark it.
            seen.add(real_d)
            # Entries in name order.
            entries = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError:
            continue
        # Each entry.
        for e in entries:
            # Hidden entries are skipped.
            if e.name.startswith("."):
                continue
            # Path and relative name.
            p, rel = Path(e.path), rel_d / e.name
            # Resolve links; a dangling link or a loop is reported without a real path.
            try:
                real = p.resolve(strict=True)
            except (OSError, RuntimeError):
                out.append((rel, None))
                continue
            # A link that leaves the root is reported without a real path.
            if not _inside(real, real_root):
                out.append((rel, None))
                continue
            # Directories are queued (symlinked ones after real ones).
            if real.is_dir():
                (linked if e.is_symlink() else stack).append((p, rel))
            # Regular files are results.
            elif real.is_file():
                out.append((rel, real))
    # Sorted by relative path.
    return sorted(out, key=lambda t: t[0].as_posix())


def _skip(files: list, rel_p: Path, status: str, why: str) -> None:
    """Record a file that contributes no text, and log why."""
    # Relative name with forward slashes.
    rel = rel_p.as_posix()
    # Record with the extension as the kind.
    files.append({"file": rel, "kind": rel_p.suffix.lower() or "?", "status": status, "chars": 0})
    # One log line.
    _log(f"ingest: {why} — {rel}")


def ingest_dir(root: Path) -> dict:
    """Parse every supported file under `root` (recursive, sorted, hidden files
    skipped). Returns {dir, files: [{file, kind, status, chars}], corpus} where
    corpus concatenates each file's text under its 来源 marker."""
    # Folder name used in the 来源 markers.
    label = root.name
    # Per-file records.
    files = []
    # Corpus sections.
    corpus = []
    # Every visible file.
    for rel_p, path in _walk_materials(root):
        # Relative name with forward slashes.
        rel = rel_p.as_posix()
        # Links that leave the folder are never read.
        if path is None:
            _skip(files, rel_p, "outside_root", "symlink leaves the materials folder (or is dangling), skipped")
            continue
        # Source label of this file.
        source = f"{label}/{rel}"
        # Read with the same per-document byte cap as fetched documents (SEARCH_FETCH_DOC_MAX_MB).
        try:
            # A stray multi-hundred-MB file must not be slurped into memory.
            if path.stat().st_size > docparse.DOC_MAX_BYTES:
                _skip(files, rel_p, "too_large", f"over {docparse.DOC_MAX_BYTES // (1024 * 1024)}MB cap, skipped")
                continue
            # The bytes.
            data = path.read_bytes()
        except OSError as ex:
            # A file deleted or unreadable mid-walk costs one record, not the whole ingest.
            _skip(files, rel_p, "error", f"unreadable ({ex}), skipped")
            continue
        # What kind of document this is.
        kind = _local_kind(rel_p, data)
        # Unsupported types are listed, not parsed.
        if not kind:
            _skip(files, rel_p, "unsupported", "unsupported file type, skipped")
            continue
        # Notes are decoded directly.
        if kind == "text":
            text = docparse._decode_text(data).strip()
        else:
            # Text layer of the document (empty for a scanned PDF).
            text = (docparse.parse_bytes(data, kind).get("text") or "").strip()
        # Nothing extracted.
        if not text:
            files.append({"file": rel, "kind": kind, "status": "empty", "chars": 0})
            _log(f"ingest: no text extracted — {rel}")
            continue
        # The parsed text lands in .search_fetchres like any fetched page, so the ledger covers local materials too.
        fit, _raw = artifacts._save_results(source, source, {"fit": text, "raw": text}, {"title": rel_p.name})
        # Ledger row.
        artifacts._append_index("ingest", source, [fit], source)
        # Record.
        files.append({"file": rel, "kind": kind, "status": "ok", "chars": len(text)})
        # Corpus section under its 来源 marker.
        corpus.append(f"##### 来源：{source}\n{text}")
        # Progress line.
        _log(f"ingest: {kind} {len(text)} chars ← {rel}")
    # Directory, records and the joined corpus.
    return {"dir": str(root), "files": files, "corpus": "\n\n".join(corpus)}


def run(dir_arg: str, as_json: bool) -> int:
    """`sf ingest <dir>`: print the corpus (or the full JSON); exit 2 when dir is not a directory."""
    # The materials folder.
    root = Path(dir_arg)
    # Usage error.
    if not root.is_dir():
        sys.stderr.write(f"ingest: not a directory: {dir_arg}\n")
        return 2
    # Parse everything.
    out = ingest_dir(root)
    # Parsed files.
    ok = sum(1 for f in out["files"] if f["status"] == "ok")
    # Summary line.
    _log(f"ingest: {ok} parsed, {len(out['files']) - ok} skipped, {len(out['corpus'])} chars")
    # JSON for machines, the corpus text otherwise.
    sys.stdout.write(json.dumps(out, ensure_ascii=False) if as_json else out["corpus"])
    # Success.
    return 0
