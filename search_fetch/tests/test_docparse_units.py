#!/usr/bin/env python3
"""Direct unit tests for the docparse parsers, OCR helpers and CLI — real files generated
on the fly (text PDF, image PDF via Pillow, docx, xlsx, GBK CSV), real pdftoppm, the OCR
Space mocked. Needs the venv (pypdf, markitdown, openpyxl, Pillow). No network.
Run: python3 tests/test_docparse_units.py
"""
# Output capture.
import contextlib
import io
import json
import shutil
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

# Import the package from ./src.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from search_fetch import config, docparse  # noqa: E402

# Scratch root inside the repository.
_TMP_ROOT = Path(__file__).resolve().parent / "tmp"


def text_pdf(text: str) -> bytes:
    """A one-page PDF with a Helvetica text layer (byte offsets computed, valid xref)."""
    # Page content stream.
    stream = f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode()
    # Objects 1–5.
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    # Assemble with offsets.
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def docx_bytes(text: str) -> bytes:
    """A minimal docx with one paragraph."""
    # In-memory zip.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                   f'<w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return buf.getvalue()


class DocparseUnitsTest(unittest.TestCase):
    def setUp(self):
        # Scratch HOME.
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.home = Path(tempfile.mkdtemp(prefix="docparse-", dir=str(_TMP_ROOT)))
        self.patch = mock.patch.object(config, "HOME", self.home)
        self.patch.start()

    def tearDown(self):
        # Restore.
        self.patch.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def test_log_and_scratch(self):
        # Prefixed stderr line; scratch lives under HOME/tmp, None standalone.
        with contextlib.redirect_stderr(io.StringIO()) as err:
            docparse._log("x")
        self.assertEqual(err.getvalue(), "[docparse] x\n")
        self.assertEqual(docparse._scratch(), str(self.home / "tmp"))
        with mock.patch.object(docparse, "config", None):
            self.assertIsNone(docparse._scratch())

    def test_host_is(self):
        # Label-aligned domain match.
        self.assertTrue(docparse._host_is("a.gov.cn", "gov.cn") and docparse._host_is("gov.cn", "gov.cn"))
        self.assertFalse(docparse._host_is("evilgov.cn", "gov.cn"))

    def test_iter_page_links(self):
        # Relative, escaped and redirect-wrapped links; script links skipped.
        html = ('<a href="/r.pdf">a</a><a href="javascript:x()">b</a><img src="i.png">'
                '<a href="https://www.google.com/url?q=https://t.example/x.docx&amp;sa=U">c</a>')
        self.assertEqual(list(docparse._iter_page_links(html, "https://s.example/p/")),
                         ["https://s.example/r.pdf", "https://s.example/p/i.png", "https://t.example/x.docx"])

    def test_zip_kind_and_magic_image(self):
        # OOXML kind from the folder; images by magic bytes.
        self.assertEqual(docparse._zip_kind(docx_bytes("x")), "docx")
        self.assertEqual(docparse._zip_kind(b"not a zip"), "")
        self.assertTrue(docparse._magic_image(b"\x89PNG\r\n") and docparse._magic_image(b"RIFF\0\0\0\0WEBPVP8 "))
        self.assertFalse(docparse._magic_image(b"%PDF-1.4"))

    def test_parse_pdf_text(self):
        # Text layer extracted; garbage gives "".
        self.assertIn("Hello WriterAgent", docparse._parse_pdf_text(text_pdf("Hello WriterAgent")))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._parse_pdf_text(b"%PDF-broken"), "")

    def test_parse_markitdown_docx_and_cleanup(self):
        # Paragraph text through markitdown; the temp copy is removed from HOME/tmp.
        self.assertIn("报告正文", docparse._parse_markitdown(docx_bytes("报告正文"), ".docx"))
        self.assertEqual(list((self.home / "tmp").iterdir()), [])
        # A converter failure gives "" (markitdown itself falls back to plain text for junk input).
        with mock.patch("markitdown.MarkItDown.convert", side_effect=ValueError("bad file")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._parse_markitdown(b"junk", ".docx"), "")
        self.assertEqual(list((self.home / "tmp").iterdir()), [])

    def test_parse_xlsx(self):
        # Every sheet with its non-empty rows.
        import openpyxl
        wb = openpyxl.Workbook()
        wb.active.title = "数据"
        wb.active.append(["地区", "数量"])
        wb.active.append(["温州", 12])
        wb.active.append([None, None])
        buf = io.BytesIO()
        wb.save(buf)
        self.assertEqual(docparse._parse_xlsx(buf.getvalue()), "## 数据\n地区 | 数量\n温州 | 12")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._parse_xlsx(b"junk"), "")

    def test_parse_csv_gbk(self):
        # GBK falls back cleanly.
        self.assertEqual(docparse._parse_csv("地区,数量\n温州,12\n".encode("gbk")), "地区,数量\n温州,12")

    def test_rasterize_pdf_real_pdftoppm(self):
        # An image-only PDF from Pillow rasterizes to one PNG inside HOME/tmp.
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (200, 100), "white").save(buf, format="PDF")
        paths, tmpdir = docparse._rasterize_pdf(buf.getvalue(), 3)
        try:
            self.assertEqual((len(paths), Path(tmpdir).parent), (1, self.home / "tmp"))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        # Missing pdftoppm is reported, not raised.
        with mock.patch.object(docparse.subprocess, "run", side_effect=FileNotFoundError), \
                contextlib.redirect_stderr(io.StringIO()):
            paths, tmpdir = docparse._rasterize_pdf(b"%PDF", 1)
        shutil.rmtree(tmpdir, ignore_errors=True)
        self.assertEqual(paths, [])

    def _fake_space(self, results):
        # A gradio_client stand-in whose predict returns or raises the queued results.
        queue = list(results)

        class Client:
            def __init__(self, *a, **k):
                pass

            def predict(self, *a, **k):
                r = queue.pop(0)
                if isinstance(r, Exception):
                    raise r
                return r

        return types.SimpleNamespace(Client=Client, handle_file=lambda p: p)

    def test_ocr_images(self):
        # Page 1 succeeds after a retry, page 2 fails every attempt and is skipped.
        fake = self._fake_space([RuntimeError("busy"), ("第一页",), RuntimeError("x"), RuntimeError("y")])
        with mock.patch.dict(sys.modules, {"gradio_client": fake}), mock.patch.object(docparse.time, "sleep"), \
                mock.patch.object(docparse, "OCR_RETRIES", 2), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._ocr_images(["a.png", "b.png"]), "第一页")
            self.assertEqual(docparse._ocr_images([]), "")

    def test_ocr_pdf_and_image_bytes_clean_up(self):
        # The rasterize dir and the temp image are removed after OCR.
        tmpdir = Path(tempfile.mkdtemp(dir=str(self.home)))
        with mock.patch.object(docparse, "_rasterize_pdf", return_value=(["p.png"], str(tmpdir))), \
                mock.patch.object(docparse, "_ocr_images", return_value="识别"):
            self.assertEqual(docparse._ocr_pdf(b"%PDF"), "识别")
        self.assertFalse(tmpdir.exists())
        seen = []
        with mock.patch.object(docparse, "_ocr_images", side_effect=lambda ps: seen.append(Path(ps[0])) or "图"):
            self.assertEqual(docparse._ocr_image_bytes(b"\x89PNG", ".png"), "图")
        self.assertEqual((seen[0].parent, seen[0].exists()), (self.home / "tmp", False))

    def test_main_cli(self):
        # Usage, a text PDF on disk, an unsupported file and a URL.
        pdf = self.home / "a.pdf"
        pdf.write_bytes(text_pdf("CLI text"))
        (self.home / "b.xyz").write_bytes(b"x")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(docparse._main([]), 2)
            self.assertEqual(docparse._main([str(self.home / "b.xyz")]), 1)
        # A short text layer triggers OCR: the Space is replaced so the test never goes online.
        with mock.patch.object(docparse, "_ocr_pdf", return_value=""), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(docparse._main([str(pdf), "--json"]), 0)
        self.assertIn("CLI text", json.loads(out.getvalue())["markdown"])
        with mock.patch.object(docparse, "try_fetch_document",
                               return_value={"final_url": "u", "text": "网页文档", "meta": {}}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(docparse._main(["https://example.com/r"]), 0)
        self.assertEqual(out.getvalue(), "网页文档\n")


if __name__ == "__main__":
    # Run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nDOCPARSE UNITS:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)
