#!/usr/bin/env python3
"""docparse pure-logic tests — NO network, NO parser libraries needed (stdlib only).

Runnable anywhere: `python3 tests/test_docparse.py`. Covers the routing decisions
(extension gate, extensionless sniff gate, kind detection from headers/magic bytes)
and the embedded-document link extraction — everything sf.py/server.py rely on
to route a URL between the browser and the document pipeline. The actual downloads,
pypdf/markitdown/openpyxl parsing are exercised by the live paths only (there is no OCR).
"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from search_fetch import docparse

_fail = 0


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


def _zip_bytes(inner_name):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(inner_name, "<x/>")
    return buf.getvalue()


def run():
    # ── extension gates: document / image / page / sniff-worthy ──
    check("pdf ext is document", docparse.looks_like_document("https://x.org/a/report.pdf"))
    check("xlsx ext is document", docparse.looks_like_document("https://x.org/data.XLSX"))
    check("png ext is document", docparse.looks_like_document("https://x.org/scan.png"))
    check("html ext is not", not docparse.looks_like_document("https://x.org/page.html"))
    check("extensionless is not (direct path)", not docparse.looks_like_document("https://x.org/download?id=7"))
    check("wrapped ddg pdf is document", docparse.looks_like_document(
        "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fz.org%2Fpaper.pdf"))
    check("wrapped google pdf is document", docparse.looks_like_document(
        "https://www.google.com/url?q=https://z.org/paper.pdf&sa=U"))

    check("extensionless worth sniffing", docparse.worth_sniffing("https://x.org/download?id=7"))
    check("bare path worth sniffing", docparse.worth_sniffing("https://x.org/report"))
    check("dot in directory is not an ext", docparse.worth_sniffing("https://x.org/v1.2/download")
          and not docparse.looks_like_document("https://x.org/v1.2.pdf/view"))
    check("unknown ext worth sniffing", docparse.worth_sniffing("https://x.org/get.action"))
    check("html not worth sniffing", not docparse.worth_sniffing("https://x.org/a.html"))
    check("txt not worth sniffing", not docparse.worth_sniffing("https://x.org/a.txt"))
    check("pdf not worth sniffing (direct)", not docparse.worth_sniffing("https://x.org/a.pdf"))
    check("png not worth sniffing (direct)", not docparse.worth_sniffing("https://x.org/a.png"))

    # ── Content-Disposition filename ──
    check("cd plain filename", docparse._cd_filename('attachment; filename="report.pdf"') == "report.pdf")
    check("cd unquoted filename", docparse._cd_filename("attachment; filename=data.xlsx") == "data.xlsx")
    check("cd rfc5987 utf-8", docparse._cd_filename(
        "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.docx") == "报告.docx")
    check("cd rfc5987 language tag", docparse._cd_filename(
        "attachment; filename*=UTF-8'en'report.pdf") == "report.pdf")
    check("cd rfc5987 wins", docparse._cd_filename(
        'attachment; filename="fallback.bin"; filename*=UTF-8\'\'real.pdf') == "real.pdf")
    check("cd none", docparse._cd_filename("inline") == "")
    check("cd empty", docparse._cd_filename("") == "")

    # ── kind detection: url ext → cd filename → content-type → magic bytes ──
    dk = docparse._detect_kind
    check("kind by url ext", dk("https://x/r.pdf", "", b"") == "pdf")
    check("kind by cd filename", dk("https://x/dl?id=1", "", b"", 'attachment; filename="a.pdf"') == "pdf")
    check("kind by cd image", dk("https://x/dl", "", b"", 'attachment; filename="scan.jpeg"') == "image")
    check("kind by content-type", dk("https://x/dl", "application/pdf", b"") == "pdf")
    check("kind by image ct", dk("https://x/dl", "image/webp", b"") == "image")
    check("kind by pdf magic", dk("https://x/dl", "", b"%PDF-1.7 rest") == "pdf")
    check("kind docx by zip interior", dk("https://x/dl", "application/octet-stream",
                                          _zip_bytes("word/document.xml")) == "docx")
    check("kind pptx by zip interior", dk("https://x/dl", "", _zip_bytes("ppt/slides/s1.xml")) == "pptx")
    check("kind xlsx by zip interior", dk("https://x/dl", "", _zip_bytes("xl/workbook.xml")) == "xlsx")
    check("plain zip is not a document", dk("https://x/dl", "", _zip_bytes("random/stuff.txt")) == "")
    check("kind png magic", dk("https://x/dl", "", b"\x89PNG\r\n\x1a\n") == "image")
    check("kind jpeg magic", dk("https://x/dl", "", b"\xff\xd8\xff\xe0") == "image")
    check("kind webp magic", dk("https://x/dl", "", b"RIFF1234WEBPVP8 ") == "image")
    check("html ct bails before magic", dk("https://x/dl", "text/html", b"PK\x03\x04junk") == "")
    check("html body is nothing", dk("https://x/dl", "", b"<!doctype html><p>hi") == "")
    check("mislabeled pdf beats html ct", dk("https://x/dl", "text/html", b"%PDF-1.4") == "pdf")

    # ── embedded document links from a rendered page ──
    html = (
        '<a href="/files/r1.pdf">annual report</a>\n'
        '<a href="https://y.com/r2.PDF#section">other</a>\n'
        '<a href="javascript:void(0)">nav</a> <a href="mailto:a@b.c">mail</a>\n'
        '<img src="/logo.png"> <iframe src="deck.pptx"></iframe>\n'
        '<a href="/files/r1.pdf">duplicate</a>\n'
        '<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fz.org%2Fdoc.docx">wrapped</a>\n'
        '<a href="/data.xlsx?dl=1">sheet</a> <a href="page.html">page</a>\n'
        '<a href="/files/a.pdf&#38;b">entity</a>'
    )
    links = docparse.extract_document_links(html, "https://base.org/sub/")
    check("resolves relative + root links", "https://base.org/files/r1.pdf" in links
          and "https://base.org/sub/deck.pptx" in links)
    check("keeps absolute + case ext", "https://y.com/r2.PDF" in links)
    check("unwraps serp redirect", "https://z.org/doc.docx" in links)
    check("keeps query string", "https://base.org/data.xlsx?dl=1" in links)
    check("dedupes", links.count("https://base.org/files/r1.pdf") == 1)
    check("skips images/pages/js", not any("logo.png" in u or "page.html" in u
                                           or u.startswith(("javascript:", "mailto:")) for u in links))
    check("dom order", links[0] == "https://base.org/files/r1.pdf")
    check("cap respected", len(docparse.extract_document_links(html, "https://base.org/", 2)) == 2)
    check("no links on empty html", docparse.extract_document_links("", "https://base.org/") == [])

    # ── hint tier: extensionless links that smell like documents (sniffed before download) ──
    hint_html = (
        '<a href="https://arxiv.org/pdf/1706.03762v7">extensionless pdf path</a>\n'
        '<a href="/download?id=42">download endpoint</a>\n'
        '<a href="/attachment.cgi?id=9">attachment behind a page-ish ext</a>\n'
        '<a href="/download.php?file=report.pdf">php with doc token</a>\n'
        '<a href="/download.php?page=2">php without doc token</a>\n'
        '<a href="/files/sure.pdf">sure thing (not a hint)</a>\n'
        '<a href="/pics/pdf.png">image (never)</a>\n'
        '<a href="https://arxiv.org/abs/1706.03762">abstract page (no hint)</a>'
    )
    hints = docparse.extract_document_hints(hint_html, "https://base.org/")
    check("hint: extensionless /pdf/ path", "https://arxiv.org/pdf/1706.03762v7" in hints)
    check("hint: download endpoint", "https://base.org/download?id=42" in hints)
    check("hint: page-ish ext needs a doc token (attachment.cgi excluded)",
          "https://base.org/attachment.cgi?id=9" not in hints)
    check("hint: php kept only with doc token",
          "https://base.org/download.php?file=report.pdf" in hints
          and "https://base.org/download.php?page=2" not in hints)
    check("hint: excludes sure/image/plain links",
          not any(("sure.pdf" in u or "pdf.png" in u or "/abs/" in u) for u in hints))
    check("hint: cap respected", len(docparse.extract_document_hints(hint_html, "https://base.org/", 2)) == 2)

    # ── saved-file suffix ──
    check("suffix pdf", docparse.doc_suffix("pdf") == ".pdf")
    check("suffix image keeps url ext", docparse.doc_suffix("image", "https://x/a.webp") == ".webp")
    check("suffix image default", docparse.doc_suffix("image", "https://x/dl") == ".png")
    check("suffix unknown kind", docparse.doc_suffix("mystery") == ".bin")

    # ── parse_bytes fallbacks that need no parser libs ──
    csv = docparse.parse_bytes(b"a,b\n1,2\n", "csv")
    check("csv decodes", csv["text"] == "a,b\n1,2" and csv["kind"] == "csv" and csv["chars"] == 7)
    unknown = docparse.parse_bytes(b"\x00\x01", "")
    check("unknown kind yields no text", unknown == {"text": "", "kind": "", "chars": 0})
    # Images carry no text layer and there is no OCR.
    check("image yields no text (no OCR)", docparse.parse_bytes(b"\x89PNG\r\n", "image")["text"] == "")

    # ── _ext semantics: the extension comes from the BASENAME only ──
    check("_ext basename pdf", docparse._ext("https://x.org/a/b/report.pdf?x=1") == ".pdf")
    check("_ext dot in dir is not an ext", docparse._ext("https://x.org/v1.2/report") == "")
    check("_ext trailing slash", docparse._ext("https://x.org/files.pdf/") == "")
    check("_ext uppercase folded", docparse._ext("https://x.org/A/B.DOCX") == ".docx")
    check("_ext extensionless", docparse._ext("https://x.org/report") == "")

    # ── sniff_remote_kind decision logic (urllib mocked — still zero network) ──
    class _Resp:
        def __init__(self, ct, cd="", body=b"", url="https://x.org/dl"):
            self._h = {"Content-Type": ct, "Content-Disposition": cd}
            self._b, self._u = body, url
        headers = property(lambda self: self)   # duck-typed: r.headers.get(...)
        def get(self, k, default=None):
            return self._h.get(k, default)
        def geturl(self):
            return self._u
        def read(self, n=-1):
            return self._b[:n] if n and n > 0 else self._b
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    # Mock at docparse's single network seam (_urlopen = url_guard policy + urllib),
    # so these routing tests never resolve or connect to anything.
    saved_open = docparse._urlopen
    try:
        # HEAD answers with a document content-type → classified with no body read
        docparse._urlopen = lambda req, timeout=None: _Resp("application/pdf")
        check("sniff: HEAD pdf ct", docparse.sniff_remote_kind("https://x.org/download?id=1") == "pdf")
        # HEAD refused; ranged GET yields a PK head under octet-stream. The zip central
        # directory is at EOF, out of the ranged read — must report PROBABLE ooxml so the
        # caller's full download can run _zip_kind for real, not silently say "not a doc".
        def _head_refused(req, timeout=None):
            if req.get_method() == "HEAD":
                raise OSError("HEAD not allowed")
            return _Resp("application/octet-stream", body=b"PK\x03\x04" + b"\x00" * 64)
        docparse._urlopen = _head_refused
        check("sniff: partial zip head → probable ooxml",
              docparse.sniff_remote_kind("https://x.org/download?id=2") == "ooxml?")
        # …but an explicit html content-type is never a document, PK head or not
        def _html_pk(req, timeout=None):
            if req.get_method() == "HEAD":
                raise OSError("HEAD not allowed")
            return _Resp("text/html", body=b"PK\x03\x04junk")
        docparse._urlopen = _html_pk
        check("sniff: html ct beats PK head", docparse.sniff_remote_kind("https://x.org/dl3") == "")
        docparse._urlopen = lambda req, timeout=None: _Resp("text/html")
        check("sniff: plain html page → ''", docparse.sniff_remote_kind("https://x.org/dl4") == "")
    finally:
        docparse._urlopen = saved_open

    print("\nDOCPARSE LOGIC:", "PASS ✓" if _fail == 0 else f"{_fail} FAILED ✗")
    return _fail == 0


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
